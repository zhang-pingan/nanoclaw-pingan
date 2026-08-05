import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  toAgentQueryFailurePatch,
} from './failure-taxonomy.js';
import {
  AgentApiResponseError,
  AgentApiTimeoutError,
  AnthropicRequestError,
  OpenAiCompatRequestError,
} from './agent-api.js';

describe('failure taxonomy', () => {
  it('classifies scheduler preflight failures', () => {
    expect(
      classifyFailure(new Error('Invalid agent folder "../../outside"'), {
        module: 'task-scheduler',
        defaultOrigin: 'scheduler',
      }),
    ).toMatchObject({
      failureType: 'invalid_input',
      failureSubtype: 'invalid_agent_folder',
      failureOrigin: 'scheduler',
      retryable: false,
    });

    expect(
      classifyFailure(new Error('Agent not found: missing-agent'), {
        module: 'task-scheduler',
        defaultOrigin: 'scheduler',
      }),
    ).toMatchObject({
      failureType: 'invalid_input',
      failureSubtype: 'agent_not_found',
      failureOrigin: 'scheduler',
      retryable: false,
    });
  });

  it('uses explicit container defaults for runtime and contract failures', () => {
    expect(
      classifyFailure(new Error('Container timed out after 30000ms'), {
        module: 'container-runner',
        defaultType: 'timeout',
        defaultSubtype: 'container_timeout_no_output',
        defaultOrigin: 'container',
        retryable: true,
      }),
    ).toMatchObject({
      failureType: 'timeout',
      failureSubtype: 'container_timeout_no_output',
      failureOrigin: 'container',
      retryable: true,
    });

    expect(
      classifyFailure(new SyntaxError('Unexpected token x'), {
        module: 'container-runner',
        defaultType: 'tool_contract_error',
        defaultSubtype: 'container_output_parse_failed',
        defaultOrigin: 'container',
        retryable: false,
      }),
    ).toMatchObject({
      failureType: 'tool_contract_error',
      failureSubtype: 'container_output_parse_failed',
      failureOrigin: 'container',
      retryable: false,
    });
  });

  it('classifies model api status and output errors', () => {
    expect(
      classifyFailure(new OpenAiCompatRequestError(429, '/v1/chat', 'busy'), {
        module: 'agent-api',
      }),
    ).toMatchObject({
      failureType: 'model_api_error',
      failureSubtype: 'model_http_non_2xx',
      failureOrigin: 'model',
      retryable: true,
    });

    expect(
      classifyFailure(new AnthropicRequestError(403, 'forbidden'), {
        module: 'agent-api',
      }),
    ).toMatchObject({
      failureType: 'model_api_error',
      failureSubtype: 'model_http_non_2xx',
      failureOrigin: 'model',
      retryable: false,
    });

    expect(
      classifyFailure(new AgentApiTimeoutError('Anthropic', 30000), {
        module: 'agent-api',
      }),
    ).toMatchObject({
      failureType: 'timeout',
      failureSubtype: 'model_fetch_timeout',
      failureOrigin: 'model',
      retryable: true,
    });

    expect(
      classifyFailure(
        new AgentApiResponseError(
          'anthropic',
          'model_empty_text',
          'Anthropic API returned no text content',
        ),
        { module: 'agent-api' },
      ),
    ).toMatchObject({
      failureType: 'model_output_invalid',
      failureSubtype: 'model_empty_text',
      failureOrigin: 'model',
      retryable: false,
    });
  });

  it('produces agent query patches', () => {
    const failure = classifyFailure(new Error('boom'), {
      module: 'test',
      defaultType: 'unknown_error',
      defaultSubtype: 'test_unknown',
      defaultOrigin: 'system',
      retryable: true,
    });

    expect(toAgentQueryFailurePatch(failure, 'boom')).toEqual({
      failure_type: 'unknown_error',
      failure_subtype: 'test_unknown',
      failure_origin: 'system',
      failure_retryable: 1,
      error_message: 'boom',
    });
  });
});
