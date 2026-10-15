import type { LlmClient } from '../../llm/client.js';
import type { SearchClient } from '../../search/types.js';
import type { DiscoveryConfig } from '../config.js';

/** Everything a pipeline stage needs. Injected so tests can supply fixtures instead of APIs. */
export interface DiscoveryDeps {
  llm: LlmClient;
  search: SearchClient;
  config: DiscoveryConfig;
  now: () => Date;
}
