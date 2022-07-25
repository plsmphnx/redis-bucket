/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

import test, { ExecutionContext } from 'ava';
import * as redis from 'redis';

import * as limiter from './index.js';

// The number of actions allowed in a burst (assuming one attempt per second,
// to make the simplifying assumption that actions and time are equivalent) is
// calculated from the burst capacity and the flow returned over that duration;
// it is the solution to the equation: time = burst + (time * flow)
function calcTime(rate: limiter.Rate, bound = false): number {
    // If a zero bound applies to this calculation,
    // the flow rate is not applied to the first check
    return +bound + (rate.burst - +bound) / (1 - rate.flow);
}

// When in constant flow, the flow value determines the number of total attempts
// per allowed action
function calcLoop(rate: limiter.Rate): number {
    return 1 / rate.flow;
}

// When calculating remaining capacity, consider the number of used actions,
// and the amount of this metric that would have been returned over that time
function calcLeft(rate: limiter.Rate, used: number, bound = false): number {
    // If a zero bound applies to this calculation,
    // the flow rate is not applied to the first check
    return rate.burst - (+bound + (used - +bound) * (1 - rate.flow));
}

// Shorthand for a 0..[n-1] array
function repeat(times: number) {
    return Array.from(Array(times).keys());
}

// Run a test against a live Redis instance
function it(
    desc: string,
    cb: (
        t: ExecutionContext,
        config: limiter.Config,
        key: string,
        now: () => number,
        sleep: (s: number) => Promise<void>
    ) => Promise<void>
) {
    test(desc, async t => {
        // Generate unique keys based on the test description
        const id = desc.replace(/ /g, '-');
        const key = `redis-bucket-test:key:${id}`;
        const time = `redis-bucket-test:time:${id}`;

        // Connect to Redis using the default values
        const raw = redis.createClient();
        await raw.connect();

        // Translate the limiter.Config format to the Redis client format
        const config: limiter.Config = {
            async eval(script, keys, argv) {
                // Patch the script, using a list to perform a controlled mock
                // of the time function
                return raw.eval(
                    script.replace(`'time'`, `'lrange','${time}',0,1`),
                    { keys, arguments: argv.map(String) }
                );
            },
            async evalsha(hash, keys, argv) {
                // This will always fail since the sha1 hash will not match
                // the patched script, but it validates the fallback path
                return raw.evalSha(hash, { keys, arguments: argv.map(String) });
            },
        };

        // Methods to utilize the controlled time mock
        let seconds = 1;
        await raw.lPush(time, ['0', '1']);
        const now = () => seconds;
        const sleep = async (s: number) => {
            seconds += s;
            await raw.lPush(time, [
                String(Math.floor((seconds % 1) * 1e6)), // Microseconds
                String(Math.floor(seconds)), // Full seconds
            ]);
        };

        // Execute the test
        await cb(t, config, key, now, sleep);

        // Clean up any keys the test may have generated
        await raw.del([key, time]);
        await raw.quit();
    });
}

it('performs basic validation', async (t, config) => {
    t.throws(() => limiter.create({ ...config }), { instanceOf: RangeError });
    t.throws(
        () =>
            limiter.create({
                ...config,
                capacity: { window: -60, min: 10, max: 20 },
            }),
        { instanceOf: RangeError }
    );
    t.throws(
        () =>
            limiter.create({
                ...config,
                capacity: { window: 60, min: 10, max: 10 },
            }),
        { instanceOf: RangeError }
    );
    t.throws(() => limiter.create({ ...config, rate: { flow: 1, burst: 0 } }), {
        instanceOf: RangeError,
    });
});

it('handles basic capacity metrics', async (t, config, key, now, sleep) => {
    const capacity: limiter.Capacity = { window: 60, min: 10, max: 20 };
    const limit = limiter.create({ ...config, capacity });

    // Perform test twice, for burst and steady-state near capacity
    for (const {} of repeat(2)) {
        const base = now();
        let allowed = 0;

        // Expend capacity for the duration of the window
        while (now() < base + capacity.window) {
            allowed += +(await limit(key)).allow;
            await sleep(1);
        }

        // Capacity should be within the bounds
        t.assert(allowed >= capacity.min);
        t.assert(allowed <= capacity.max);
    }
});

it('handles basic rate metrics', async (t, config, key, now, sleep) => {
    const rate: limiter.Rate = { burst: 9, flow: 1 / 2 };
    const limit = limiter.create({ ...config, rate });

    // Perform test twice to ensure full drain
    for (const {} of repeat(2)) {
        const base = now();
        let free = rate.burst - 1;

        // Expect initial burst to be allowed
        const time = calcTime(rate, true);
        while (now() < base + time) {
            t.deepEqual(await limit(key), { allow: true, free });
            await sleep(1);
            free += rate.flow - 1;
        }

        // Expect steady-state of flow rate near capacity
        const loop = calcLoop(rate);
        while (now() < base + time + loop * 4) {
            let allowed = 0;
            for (const {} of repeat(loop)) {
                allowed += +(await limit(key)).allow;
                await sleep(1);
            }
            t.is(allowed, 1);
        }

        // Once the flow would return the full burst capacity,
        // behavior should be reset to baseline
        await sleep(rate.burst / rate.flow);
    }
});

it('handles multiple rates', async (t, config, key, now, sleep) => {
    const slow: limiter.Rate = { burst: 18, flow: 1 / 4 };
    const fast: limiter.Rate = { burst: 9, flow: 1 / 2 };
    const limit = limiter.create({
        ...config,
        rate: [slow, fast],
        backoff: limiter.backoff.exponential(2),
    });
    const base = now();
    let free = fast.burst - 1;

    // Expect initial burst to be allowed
    const timeFast = calcTime(fast, true);
    while (now() < base + timeFast) {
        t.deepEqual(await limit(key), { allow: true, free });
        await sleep(1);
        free += fast.flow - 1;
    }

    // Expect fast flow rate until slow burst is consumed
    const loopFast = calcLoop(fast);
    const timeSlow =
        calcTime({
            burst: calcLeft(slow, timeFast, true),
            flow: slow.flow / fast.flow,
        }) * loopFast;
    while (now() < base + timeFast + timeSlow) {
        let allowed = 0;
        for (const {} of repeat(loopFast)) {
            allowed += +(await limit(key)).allow;
            await sleep(1);
        }
        t.is(allowed, 1);
    }

    // Expect slow flow rate afterwards
    const loopSlow = calcLoop(slow);
    let wait: number | undefined;
    while (now() < base + timeFast + timeSlow + loopSlow * 4) {
        let allowed = 0;
        for (const {} of repeat(loopSlow)) {
            const result = await limit(key);
            if (result.allow) {
                allowed += 1;
            } else if (wait) {
                t.is(result.wait, 2 * wait);
            }
            wait = (result as any).wait;
            await sleep(1);
        }
        t.is(allowed, 1);
    }
});

it('handles subsecond deltas', async (t, config, key, now, sleep) => {
    const capacity: limiter.Capacity = { window: 1, min: 4, max: 5 };
    const limit = limiter.create({ ...config, capacity });

    const base = now();
    let allowed = 0;

    // Expend capacity for the duration of the window
    while (now() < base + capacity.window) {
        allowed += +(await limit(key)).allow;
        await sleep(0.125);
    }

    // Capacity should be within the bounds
    t.assert(allowed >= capacity.min);
    t.assert(allowed <= capacity.max);
});

it('discards superfluous rates', async (t, _, key) => {
    const config: limiter.Config = {
        async eval(script, keys, argv) {
            t.deepEqual(keys, [key]);
            t.deepEqual(argv, [1, 0.1, 4, 0.2, 2, 0.4, 1]);
            return [1, 1, 1];
        },
    };

    const rate: limiter.Rate[] = [
        { burst: 4, flow: 0.1 }, // 1 - Valid
        { burst: 3, flow: 0.2 }, // 2 - Strictly larger than 3
        { burst: 2, flow: 0.2 }, // 3 - Valid
        { burst: 2, flow: 0.3 }, // 4 - Strictly larger than 3
        { burst: 1, flow: 0.4 }, // 5 - Valid
    ];
    await limiter.create({ ...config, rate })(key);
});

it('passes errors through', async (t, _, key) => {
    const error = Error();
    const config: limiter.Config = {
        async eval() {},
        async evalsha() {
            throw error;
        },
    };

    try {
        const rate: limiter.Rate = { burst: 4, flow: 0.1 };
        await limiter.create({ ...config, rate })(key);
        t.fail('should throw underlying error');
    } catch (err) {
        t.is(err, error);
    }
});

it('performs the expected scaling', async t => {
    const factor = 2;
    const denied = 3;
    const expected = {
        constant: 2,
        linear: 6,
        power: 9,
        exponential: 8,
    };
    for (const [key, val] of Object.entries(limiter.backoff)) {
        t.is(val(factor)(denied), expected[key]);
    }
});
