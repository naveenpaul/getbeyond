import type {
  DestinationAdapter,
  DraftActionKind,
  ExecuteParams,
  ExecuteResult,
} from '@getbeyond/shared';

/**
 * Test-only stub destination. Registered ALONGSIDE real destinations in test
 * environments so the worker has something to call for every kind. Production
 * skips this destination — kinds without a registered real adapter fail
 * loudly, which is the right behavior (don't silently swallow approved
 * actions because their vendor integration isn't built yet).
 *
 * Behavior:
 *   - idempotencyKey starts with `test-fail:` → returns `failed`
 *   - otherwise → returns `succeeded` with the action echoed back
 *
 * The failure signal lives on idempotencyKey rather than inside the payload
 * because the worker passes the Zod-validated payload (with unknown fields
 * stripped). Smuggling a sentinel inside the payload would require
 * passthrough mode on every schema, which weakens production safety.
 */
export const TEST_FAIL_IDEMPOTENCY_PREFIX = 'test-fail:';

export class EchoDestination
  implements DestinationAdapter<Record<string, unknown>>
{
  readonly kind = 'echo';
  readonly supports: readonly DraftActionKind[] = [
    'send_email',
    'post_linkedin',
    'post_twitter',
    'crm_log_activity',
    'crm_update_field',
  ];

  async execute(
    params: ExecuteParams<Record<string, unknown>>,
  ): Promise<ExecuteResult> {
    if (params.idempotencyKey.startsWith(TEST_FAIL_IDEMPOTENCY_PREFIX)) {
      return {
        status: 'failed',
        responsePayload: { echoed: params.action },
        retryable: false,
        error: 'echo destination test_fail sentinel',
      };
    }
    return {
      status: 'succeeded',
      externalId: `echo-${params.idempotencyKey}`,
      responsePayload: { echoed: params.action },
    };
  }
}
