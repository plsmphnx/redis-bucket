/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

// Common validation shorthand
function validate(message: string, condition: any) {
    if (!condition) {
        throw RangeError(message);
    }
}

// Validate capacity metrics and translate them into rate metrics
function validateCapacity(input: Capacity): Rate {
    validate(
        'All capacity parameters must be greater than zero.',
        input.min > 0 && input.window > 0
    );
    validate(
        'Maximum capacity must be greater than minimum capacity.',
        input.max > input.min
    );

    return {
        flow: input.min / input.window,
        burst: input.max - input.min,
    };
}

// Validate rate metrics
function validateRate(input: Rate): Rate {
    validate(
        'All rate parameters must be greater than zero.',
        input.burst > 0 && input.flow > 0
    );

    return input;
}

// Validate and sort limits
function validateLimits(...input: Rate[]): Rate[] {
    validate(
        'At least one rate or capacity metric must be specified.',
        input.length
    );

    let g: number;

    // Sort rates by the slowest to fastest flow for consistency, or by burst
    // if flow is the same (to make them easier to filter out later)
    const limits = input.sort((a, b) => a.flow - b.flow || a.burst - b.burst);

    // Any limit that is strictly larger than another (in both burst and flow)
    // is superfluous, as the smaller limit will always be more restrictive
    return limits.filter(
        (l, i, ls) => (!g || l.burst < ls[g - 1].burst) && (g = i + 1)
    );
}

/**
 * Create a new rate-limiter test function
 * @param config Configuration options
 */
export function create({
    client,
    prefix = '',
    factor = 2,
    scaling = SCALING.linear,
    capacity = [],
    rate = [],
}: Config): Test {
    // Precalculate values not dependent on test arguments
    const loader = typeof client === 'function' ? client : () => client;
    const limits = validateLimits(
        ...([] as Capacity[]).concat(capacity).map(validateCapacity),
        ...([] as Rate[]).concat(rate).map(validateRate)
    );
    const params = limits.reduce(
        (args, limit) => args.concat(limit.flow, limit.burst),
        [] as number[]
    );

    // Execute the Lua script on the Redis client to check available capacity
    return async (key, cost = 1) => {
        // Lazy-load the client
        const redis: any = await loader();

        // Translate function arguments to Redis arguments
        const args = [1, prefix + key, Math.max(cost, 0), ...params];

        // Build a promise-resolving callback
        let cb: (err: any, res: any) => void;
        const response = new Promise<unknown[]>(
            (resolve, reject) =>
                (cb = (err, res) => (err ? reject(err) : resolve(res)))
        );

        // Manage the script in the Redis cache
        redis.evalsha('{{LUA_HASH}}', ...args, (err: any, res: any) =>
            /NOSCRIPT/.test(String(err))
                ? redis.eval('{{LUA_CODE}}', ...args, cb)
                : cb(err, res)
        );

        // Translate the Redis response into a result object
        const [allow, value, index] = await response;
        return Number(allow)
            ? {
                  allow: true,
                  free: Number(value),
              }
            : {
                  allow: false,
                  wait:
                      (cost / limits[Number(index) - 1].flow) *
                      scaling(factor, Number(value) / cost),
              };
    };
}

/** Rate-limiter instance configuration options */
export interface Config {
    /** Redis client used by this instance (optionally lazy and/or async) */
    client: (Client | Promise<Client>) | (() => Client | Promise<Client>);

    /** Prefix all keys with this value (default empty) */
    prefix?: string;

    /** Backoff factor (default 2) */
    factor?: number;

    /** Backoff scaling function (default linear) */
    scaling?(factor: number, denied: number): number;

    /** Capacity metric(s) to limit by */
    capacity?: Capacity | Capacity[];

    /** Rate metric(s) to limit by */
    rate?: Rate | Rate[];
}

/** Redis client supporting eval/evalsha */
export interface Client {
    eval(script: string, keys: number, ...args: any[]): unknown;
    evalsha(hash: string, keys: number, ...args: any[]): unknown;
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

/** Predefined backoff scaling functions */
export const SCALING = {
    /** Constant scaling (factor) */
    constant: (factor: number) => factor,

    /** Linear scaling (factor * denied) */
    linear: (factor: number, denied: number) => factor * denied,

    /** Power scaling (denied ** factor) */
    power: (factor: number, denied: number) => denied ** factor,

    /** Exponential scaling (factor ** denied) */
    exponential: (factor: number, denied: number) => factor ** denied,
};

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
