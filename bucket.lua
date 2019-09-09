-- Copyright (c) Microsoft Corporation.
-- Licensed under the MIT License.

redis.replicate_commands()

-- Parse the input values
local key, cost = KEYS[1], tonumber(ARGV[1])

-- Parse the Redis values
local raw = redis.call('time')
local now = tonumber(raw[1]) + tonumber(raw[2]) / 1e6
local okay, time, deny, prev = pcall(cmsgpack.unpack, redis.pcall('get', key))

-- If there were any failures, reset the metrics
if not okay then
	time, deny, prev = now, 0, {}
end

-- Calculate the time delta since last access
local delta = now - time

-- Initialize values calculated against the metrics
local next, expire, free, index = {}, 0, math.huge

-- Loop through each rate metric provided in the input
for i = 1, #ARGV / 2 do
	local flow, burst = tonumber(ARGV[2 * i]), tonumber(ARGV[2 * i + 1])

	-- Adjust the used capacity by the flow rate and cost
	prev[i] = math.max(0, (prev[i] or 0) - (delta * flow))
	next[i] = prev[i] + cost

	-- Record the minimum remaining free capacity
	if (burst - next[i]) < free then
		free, index = burst - next[i], i
	end

	-- Record the maximum possible expiry window
	expire = math.max(expire, math.ceil(math.max(burst, next[i]) / flow))
end

-- Write the new counts to the database
if free >= 0 then
	redis.call('setex', key, expire, cmsgpack.pack(now, 0, next))
	return { 1, tostring(free), index }
else
	deny = deny + cost
	redis.call('setex', key, expire, cmsgpack.pack(now, deny, prev))
	return { 0, tostring(deny), index }
end