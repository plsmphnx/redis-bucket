/*!
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 */

import * as redis from 'fakeredis';
import mockEval from 'redis-eval-mock';

import * as Limiter from './index';

// The number of actions allowed in a burst (assuming one attempt per second,
// to make the simplifying assumption that actions and time are equivalent) is
// calculated from the burst capacity and the flow returned over that duration;
// it is the solution to the equation: time = burst + (time * flow)
function calcTime(rate: Limiter.Rate, bound = false): number {
    // If a zero bound applies to this calculation,
    // the flow rate is not applied to the first check
    return +bound + (rate.burst - +bound) / (1 - rate.flow);
}

// When in constant flow, the flow value determines the number of total attempts
// per allowed action
function calcLoop(rate: Limiter.Rate): number {
    return 1 / rate.flow;
}

// When calculating remaining capacity, consider the number of used actions,
// and the amount of this metric that would have been returned over that time
function calcLeft(rate: Limiter.Rate, used: number, bound = false): number {
    // If a zero bound applies to this calculation,
    // the flow rate is not applied to the first check
    return rate.burst - (+bound + (used - +bound) * (1 - rate.flow));
}

// Shorthand for a 0..[n-1] array
function repeat(times: number) {
    return Array.from(Array(times).keys());
}

describe('redis-bucket', () => {
    let seconds: number;
    let client: redis.RedisClient;

    beforeEach(() => {
        client = mockEval(
            redis.createClient({ fast: true } as redis.ClientOpts)
        );
        seconds = 1;
        jest.spyOn(Date, 'now').mockImplementation(() => seconds * 1000);
        jest.spyOn(Math, 'random').mockReturnValue(0);
    });

    it('performs basic validation', () => {
        expect(() => Limiter.create({ client })).toThrow(RangeError);
        expect(() =>
            Limiter.create({
                client,
                capacity: { window: -60, min: 10, max: 20 },
            })
        ).toThrow(RangeError);
        expect(() =>
            Limiter.create({
                client,
                capacity: { window: 60, min: 10, max: 10 },
            })
        ).toThrow(RangeError);
        expect(() =>
            Limiter.create({ client, rate: { flow: 1, burst: 0 } })
        ).toThrow(RangeError);
    });

    it('handles basic capacity metrics', async () => {
        const capacity: Limiter.Capacity = { window: 60, min: 10, max: 20 };
        const limit = Limiter.create({ client, capacity });

        // Perform test twice, for burst and steady-state near capacity
        for (const {} of repeat(2)) {
            const base = seconds;
            let allowed = 0;

            // Expend capacity for the duration of the window
            while (seconds < base + capacity.window) {
                allowed += +(await limit('capacity')).allow;
                seconds += 1;
            }

            // Capacity should be within the bounds
            expect(allowed).toBeGreaterThanOrEqual(capacity.min);
            expect(allowed).toBeLessThanOrEqual(capacity.max);
        }
    });

    it('handles basic rate metrics', async () => {
        const rate: Limiter.Rate = { burst: 9, flow: 1 / 2 };
        const limit = Limiter.create({ client, rate });

        // Perform test twice to ensure full drain
        for (const {} of repeat(2)) {
            const base = seconds;
            let free = rate.burst - 1;

            // Expect initial burst to be allowed
            const time = calcTime(rate, true);
            while (seconds < base + time) {
                expect(await limit('rate')).toEqual({ allow: true, free });
                seconds += 1;
                free += rate.flow - 1;
            }

            // Expect steady-state of flow rate near capacity
            const loop = calcLoop(rate);
            while (seconds < base + time + loop * 4) {
                let allowed = 0;
                for (const {} of repeat(loop)) {
                    allowed += +(await limit('rate')).allow;
                    seconds += 1;
                }
                expect(allowed).toBe(1);
            }

            // Once the flow would return the full burst capacity,
            // behavior should be reset to baseline
            seconds += rate.burst / rate.flow;
        }
    });

    it('handles multiple rates', async () => {
        const slow: Limiter.Rate = { burst: 18, flow: 1 / 4 };
        const fast: Limiter.Rate = { burst: 9, flow: 1 / 2 };
        const scaling = Limiter.SCALING.exponential;
        const limit = Limiter.create({
            client: () => Promise.resolve(client),
            rate: [slow, fast],
            scaling,
        });
        const base = seconds;
        let free = fast.burst - 1;

        // Expect initial burst to be allowed
        const timeFast = calcTime(fast, true);
        while (seconds < base + timeFast) {
            expect(await limit('multiple')).toEqual({ allow: true, free });
            seconds += 1;
            free += fast.flow - 1;
        }

        // Expect fast flow rate until slow burst is consumed
        const loopFast = calcLoop(fast);
        const timeSlow =
            calcTime({
                burst: calcLeft(slow, timeFast, true),
                flow: slow.flow / fast.flow,
            }) * loopFast;
        while (seconds < base + timeFast + timeSlow) {
            let allowed = 0;
            for (const {} of repeat(loopFast)) {
                allowed += +(await limit('multiple')).allow;
                seconds += 1;
            }
            expect(allowed).toBe(1);
        }

        // Expect slow flow rate afterwards
        const loopSlow = calcLoop(slow);
        let wait: number | undefined;
        while (seconds < base + timeFast + timeSlow + loopSlow * 4) {
            let allowed = 0;
            for (const {} of repeat(loopSlow)) {
                const result = await limit('multiple');
                if (result.allow) {
                    allowed += 1;
                } else if (wait) {
                    expect(result.wait).toBe(2 * wait);
                }
                wait = (result as any).wait;
                seconds += 1;
            }
            expect(allowed).toBe(1);
        }
    });

    it('handles subsecond deltas', async () => {
        const capacity: Limiter.Capacity = { window: 1, min: 4, max: 5 };
        const limit = Limiter.create({ client, capacity });

        const base = seconds;
        let allowed = 0;

        // Expend capacity for the duration of the window
        while (seconds < base + capacity.window) {
            allowed += +(await limit('subsecond')).allow;
            seconds += 0.125;
        }

        // Capacity should be within the bounds
        expect(allowed).toBeGreaterThanOrEqual(capacity.min);
        expect(allowed).toBeLessThanOrEqual(capacity.max);
    });

    it('discards superfluous rates', async () => {
        const evalSpy = jest.spyOn(client, 'evalsha');

        const rate: Limiter.Rate[] = [
            { burst: 4, flow: 0.1 }, // 1 - Valid
            { burst: 3, flow: 0.2 }, // 2 - Strictly larger than 3
            { burst: 2, flow: 0.2 }, // 3 - Valid
            { burst: 2, flow: 0.3 }, // 4 - Strictly larger than 3
            { burst: 1, flow: 0.4 }, // 5 - Valid
        ];
        await Limiter.create({ client, rate })('extra');

        expect(evalSpy).toHaveBeenCalledWith(
            expect.any(String),
            1,
            'extra',
            1,
            ...[0.1, 4, 0.2, 2, 0.4, 1],
            expect.any(Function)
        );
    });

    it('passes errors through', async () => {
        const error = Error();
        jest.spyOn(client, 'evalsha').mockImplementation((...args: any[]) =>
            args.pop()(error)
        );

        try {
            const rate: Limiter.Rate = { burst: 4, flow: 0.1 };
            await Limiter.create({ client, rate })('error');
            fail('should throw underlying error');
        } catch (err) {
            expect(err).toBe(error);
        }
    });

    it('performs the expected scaling', async () => {
        const factor = 2;
        const denied = 3;
        const expected = {
            constant: 2,
            linear: 6,
            power: 9,
            exponential: 8,
        };
        for (const [key, val] of Object.entries(Limiter.SCALING)) {
            expect(val(factor, denied)).toBe(expected[key]);
        }
    });
});
