/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

// Common validation shorthand
function validate(message: string, condition: unknown) {
    if (!condition) {
        throw RangeError(message);
    }
}

// Validate capacity metrics and translate them into flow/burst pairs
function validateCapacity({ min, max, window }: Capacity): [number, number] {
    validate(
        'All capacity parameters must be greater than zero',
        min > 0 && window > 0
    );
    validate(
        'Maximum capacity must be greater than minimum capacity',
        max > min
    );

    return [min / window, max - min];
}

// Validate rate metrics and translate them into flow/burst pairs
function validateRate({ flow, burst }: Rate): [number, number] {
    validate(
        'All rate parameters must be greater than zero',
        flow > 0 && burst > 0
    );

    return [flow, burst];
}

// Validate and sort flow/burst pairs and translate them to script parameters
function validateLimits(...input: number[][]): number[] {
    validate(
        'At least one rate or capacity metric must be specified',
        input.length
    );

    // Sort rates by the slowest to fastest flow for consistency, or by burst
    // if flow is the same (to make them easier to filter out later)
    const limits = input.sort(
        ([flow1, burst1], [flow2, burst2]) => flow1 - flow2 || burst1 - burst2
    );

    // Any limit that is strictly larger than another (in both flow and burst)
    // is superfluous, as the smaller limit will always be more restrictive
    return limits.reduce((params, [flow, burst]) =>
        burst < params[params.length - 1] ? [...params, flow, burst] : params
    );
}

/**
 * Create a new rate-limiter test function
 * @param config Configuration options
 */
export function create({
    eval: code,
    evalsha: hash,
    prefix = '',
    backoff = x => 2 * x,
    capacity = [],
    rate = [],
}: Config): Test {
    // Precalculate parameters not dependent on test arguments
    const params = validateLimits(
        ...([] as Capacity[]).concat(capacity).map(validateCapacity),
        ...([] as Rate[]).concat(rate).map(validateRate)
    );

    // Execute the Lua script on the Redis client to check available capacity
    return async (key, cost = 1) => {
        // Translate function arguments to Redis arguments
        const keys = [prefix + key];
        const argv = [cost, ...params];

        // Evaluate the script in the Redis cache
        const [allow, value, index] =
            (await hash?.('{{LUA_HASH}}', keys, argv).catch(err => {
                if (!/NOSCRIPT/.test(err)) {
                    throw err;
                }
            })) || (await code('{{LUA_CODE}}', keys, argv));

        // Translate the Redis response into a result object
        return +allow
            ? {
                  allow: true,
                  free: +value,
              }
            : {
                  allow: false,
                  wait: (cost / params[2 * index - 2]) * backoff(value / cost),
              };
    };
}

/** Rate-limiter instance configuration options */
export interface Config {
    /** EVAL call to Redis */
    eval(script: string, keys: string[], argv: unknown[]): Promise<any>;

    /** EVALSHA call to Redis */
    evalsha?(hash: string, keys: string[], argv: unknown[]): Promise<any>;

    /** Prefix all keys with this value (default empty) */
    prefix?: string;

    /** Backoff scaling function (default 2x linear) */
    backoff?(denied: number): number;

    /** Capacity metric(s) to limit by */
    capacity?: Capacity | Capacity[];

    /** Rate metric(s) to limit by */
    rate?: Rate | Rate[];
}

/** A rate metric to limit by */
export interface Rate {
    /** The rate at which capacity is restored (per second) */
    flow: number;

    /** The allowed capacity before requests start to be denied */
    burst: number;
}

/** A capacity metric to limit by */
export interface Capacity {
    /** Time window over which to apply this capacity (in seconds) */
    window: number;

    /** Minimum guaranteed capacity */
    min: number;

    /** Maximum tolerable capacity */
    max: number;
}

/** Result type for an allowed action */
export interface Allow {
    /** Allow this action */
    allow: true;

    /** Remaining free capacity */
    free: number;
}

/** Result type for a rejected action */
export interface Reject {
    /** Do not allow this action */
    allow: false;

    /** Wait this long before trying again (in seconds) */
    wait: number;
}

/** Possible results for a rate limited action */
export type Result = Allow | Reject;

/**
 * Rate-limiter test execution function
 * @param key The key against which this rate should be tested
 * @param cost (default 1) The abstract cost of this operation
 */
export type Test = (key: string, cost?: number) => Promise<Result>;
