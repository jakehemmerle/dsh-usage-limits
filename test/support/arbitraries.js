import fc from 'fast-check';
import { NOW0, HOUR } from './host.js';

export const wildNumber = fc.oneof(
  fc.integer({ min: -50, max: 250 }),
  fc.double({ min: -2, max: 300, noNaN: false }),
  fc.constantFrom(0, 0.08, 0.5, 0.999, 1, 1.5, 75, 89.5, 90, 100, 100.4, Number.MAX_SAFE_INTEGER),
  fc.string({ maxLength: 4 }),
  fc.constant(null),
);

export const percentLike = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 100 }) },
  { weight: 1, arbitrary: wildNumber },
);

const isoAround = fc.integer({ min: -48, max: 24 * 14 }).map((h) => new Date(NOW0 + h * HOUR + 219).toISOString());

export const resetsAtLike = fc.oneof(
  { weight: 4, arbitrary: isoAround },
  { weight: 1, arbitrary: fc.oneof(fc.constant(null), fc.string({ maxLength: 8 }), fc.integer()) },
);

const epochSecondsAround = fc.integer({ min: -48, max: 24 * 14 }).map((h) => Math.floor((NOW0 + h * HOUR) / 1000));

export const windowSeconds = fc.oneof(
  fc.constantFrom(18000, 604800, 3600, 86400, 2592000),
  fc.integer({ min: 60, max: 40 * 86400 }),
);

const displayName = fc.oneof(fc.constantFrom('Fable', 'Opus', 'Sonnet'), fc.string({ maxLength: 12 }));

const anthropicLimit = fc.record({
  kind: fc.oneof(fc.constantFrom('session', 'weekly_all', 'weekly_scoped'), fc.string({ maxLength: 8 })),
  group: fc.constantFrom('session', 'weekly'),
  percent: percentLike,
  severity: fc.constantFrom('normal', 'warning', 'critical'),
  resets_at: resetsAtLike,
  scope: fc.oneof(fc.constant(null), fc.record({ model: fc.record({ id: fc.constant(null), display_name: displayName }) })),
  is_active: fc.boolean(),
}, { requiredKeys: ['kind'] });

const legacyWindow = fc.oneof(
  fc.constant(null),
  fc.record({ utilization: percentLike, resets_at: resetsAtLike }, { requiredKeys: [] }),
);

export const anthropicBody = fc.record({
  limits: fc.oneof(fc.array(anthropicLimit, { maxLength: 5 }), fc.constant(null)),
  five_hour: legacyWindow,
  seven_day: legacyWindow,
  seven_day_opus: legacyWindow,
  seven_day_sonnet: legacyWindow,
  iguana_necktie: fc.jsonValue({ maxDepth: 1 }),
}, { requiredKeys: [] });

export const codexWindow = fc.record({
  used_percent: percentLike,
  limit_window_seconds: fc.oneof({ weight: 5, arbitrary: windowSeconds }, { weight: 1, arbitrary: wildNumber }),
  reset_after_seconds: fc.integer({ min: 0, max: 30 * 86400 }),
  reset_at: fc.oneof({ weight: 4, arbitrary: epochSecondsAround }, { weight: 1, arbitrary: wildNumber }),
}, { requiredKeys: ['used_percent'] });

const codexRateLimit = fc.record({
  allowed: fc.boolean(),
  primary_window: fc.oneof(codexWindow, fc.constant(null)),
  secondary_window: fc.oneof(codexWindow, fc.constant(null)),
}, { requiredKeys: [] });

export const codexBody = fc.record({
  plan_type: fc.oneof(fc.constantFrom('plus', 'pro', 'self_serve_business_prolite'), fc.constant(null), fc.integer()),
  rate_limit: fc.oneof(codexRateLimit, fc.constant(null)),
  additional_rate_limits: fc.oneof(
    fc.constant(null),
    fc.array(fc.record({ limit_name: fc.oneof(fc.string({ maxLength: 12 }), fc.constant(null)), rate_limit: fc.oneof(codexRateLimit, fc.constant(null)) }, { requiredKeys: [] }), { maxLength: 3 }),
  ),
  spend_control: fc.oneof(
    fc.constant(null),
    fc.record({ reached: fc.boolean(), individual_limit: fc.oneof(fc.constant(null), fc.record({ used_percent: percentLike, reset_at: fc.oneof(epochSecondsAround, wildNumber) }, { requiredKeys: [] })) }),
  ),
}, { requiredKeys: [] });

export const anyStatus = fc.oneof(
  { weight: 4, arbitrary: fc.constant(200) },
  { weight: 3, arbitrary: fc.integer({ min: 200, max: 599 }) },
  { weight: 2, arbitrary: fc.constantFrom(401, 403, 429, 500, 502, 503) },
);

export function upstreamExchange(shaped) {
  return fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('response'), status: anyStatus, body: fc.oneof(shaped.map((v) => JSON.stringify(v)), fc.json(), fc.string({ maxLength: 20 })) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('response'), status: fc.constant(429), body: fc.constant('{}'), retryAfter: fc.oneof(fc.integer({ min: 0, max: 7200 }).map(String), fc.string({ maxLength: 6 })) }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'throw' }) },
  );
}

export const tokenString = fc
  .tuple(fc.constantFrom('sk-ant-oat01-', 'sk-ant-ort01-', 'eyJ', 'rt_', ''), fc.stringMatching(/^[A-Za-z0-9_-]{20,60}$/))
  .map(([prefix, body]) => prefix + body);
