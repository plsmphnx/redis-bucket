# redis-bucket

[![Travis CI build status](https://travis-ci.org/plsmphnx/redis-bucket.svg?branch=master)](https://travis-ci.org/plsmphnx/redis-bucket)
[![codecov](https://codecov.io/gh/plsmphnx/redis-bucket/branch/master/graph/badge.svg)](https://codecov.io/gh/plsmphnx/redis-bucket)
[![npm version](https://img.shields.io/npm/v/redis-bucket.svg)](https://npmjs.org/package/redis-bucket)

A Redis-backed rate limiter, based on the
[leaky-bucket algorithm](https://en.wikipedia.org/wiki/Leaky_bucket#As_a_meter).
Implemented using a purely EVAL-based solution, which provides the following
advantages:

-   It is optimized for cases where multiple instances of a service share common
    rate-limiting metrics, since the counts are shared via a single store.
-   It supports multiple simultaneous metrics, allowing for tiered rates.
-   It works with hosted Redis solutions that may not support custom modules.

## Requirements

-   _Development_ - Node.JS 8.x or higher.
-   _Runtime_ - A Redis client supporting callback-style `eval` and `evalsha`.

## API

### create(config)

Creates a [test function](#testkey-cost) to perform rate limiting against a
given set of metrics. Takes a configuration object containing the following
options:

-   `client` - A Redis client object to be used by this instance. Note that the
    caller must manage this client (e.g. listen to `error` events). May
    optionally be asynchronous and/or a function that returns the client (which
    will be called when each test is run).
-   `prefix` _(default none)_ - A string prefix to apply to all Redis keys used
    by this instance.
-   `factor` _(default 2)_ - The backoff factor used for retries.
-   `scaling` _(default linear)_ - The backoff scaling function used for
    retries, using the provided factor.
-   `capacity` - A capacity metric (or array thereof) to limit by (see
    [below](#capacity-limits)).
-   `rate` - A rate metric (or array thereof) to limit by (see
    [below](#rate-limits)).

### _test_(key, [cost])

Tests whether the given action should be allowed according to the rate limits.
Returns a [`Result`](#result) object. Takes the following arguments:

-   `key` - A string specifying the instance to be tested. Limits will only be
    applied to a given key against itself.
-   `cost` _(default 1)_ - The capacity cost of this action (see
    [below](#specifying-limits)).

### Result

An object representing the result of a test. Contains the following parameters:

-   `allow` _(boolean)_ - Whether or not this action should be allowed according
    to the rate limits.
-   `free` _(if `allow` is `true`; number)_ - The current remaining capacity
    before actions will be rejected.
-   `wait` _(if `allow` is `false`; number)_ - How long the caller should wait
    before trying again, in seconds.

## Specifying Limits

The allowable limits for a given instance of the rate-limiter can be specified
in two ways. Note that 'capacity' is an abstract value; typically it represents
a number of actions, but it can also indicate an overall net 'cost' of actions.

### Capacity Limits

Capacity limits are specified using three values:

-   `window` - The time window over which these limits are considered, in
    seconds.
-   `min` - The minimum capacity that is guaranteed over this time window,
    assuming a perfectly uniform call pattern (see note below).
-   `max` - The maximum capacity that the system can handle over this time
    window. This value is absolute; callers will be limited in such a way to
    enforce this. It must be sufficiently greater than the minimum capacity to
    cover the highest cost the test function will be called with.

**Note**: If the maximum capacity is set as low as possible (in other words,
just greater than the minimum capacity), the caller must request capacity in a
perfectly uniform manner in order to receive the minimum capacity. This
restriction becomes increasingly loose as the maximum capacity increases,
disappearing when the maximum capacity is twice the minimum capacity (at which
point the minimum capacity becomes guaranteed independent of the call pattern).

### Rate Limits

Rate limits are specified using two values:

-   `flow` - The rate at which capacity becomes available, per second. In a
    fully-stressed system, calls will be limited to exactly this rate.
-   `burst` - The amount of leeway in capacity the system can support. This is
    the amount of capacity that can be utilized before rate-limiting is applied.
    It must be at least equal to the highest cost the test function will be
    called with.

## Contributing

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any
additional questions or comments.
