/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  BackstageCredentials,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { JsonObject } from '@backstage/types';
import {
  ActionsService,
  MetricsServiceHistogram,
  MetricsService,
} from '@backstage/backend-plugin-api/alpha';
import { version } from '@backstage/plugin-mcp-actions-backend/package.json';
import { NotFoundError } from '@backstage/errors';
import { performance } from 'node:perf_hooks';

import { handleErrors } from './handleErrors';
import { bucketBoundaries, McpServerOperationAttributes } from '../metrics';

export class McpService {
  private readonly actions: ActionsService;
  private readonly config: RootConfigService;
  private readonly operationDuration: MetricsServiceHistogram<McpServerOperationAttributes>;

  constructor(
    actions: ActionsService,
    metrics: MetricsService,
    config: RootConfigService,
  ) {
    this.actions = actions;
    this.config = config;
    this.operationDuration =
      metrics.createHistogram<McpServerOperationAttributes>(
        'mcp.server.operation.duration',
        {
          description: 'MCP request duration as observed on the receiver',
          unit: 's',
          advice: { explicitBucketBoundaries: bucketBoundaries },
        },
      );
  }

  static async create({
    actions,
    metrics,
    config,
  }: {
    actions: ActionsService;
    metrics: MetricsService;
    config: RootConfigService;
  }) {
    return new McpService(actions, metrics, config);
  }

  getServer({ credentials }: { credentials: BackstageCredentials }) {
    const server = new McpServer(
      {
        name: 'backstage',
        // TODO: this version will most likely change in the future.
        version,
      },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const startTime = performance.now();
      let errorType: string | undefined;

      try {
        const { actions } = await this.actions.list({ credentials });
        const overrides = this.getOverrides();

        return {
          tools: actions.map(action => {
            const override = overrides.get(action.id);
            return {
              inputSchema: action.schema.input,
              // todo(blam): this is unfortunately not supported by most clients yet.
              // When this is provided you need to provide structuredContent instead.
              // outputSchema: action.schema.output,
              name: override?.name ?? action.name,
              description: override?.description ?? action.description,
              annotations: {
                title: override?.title ?? action.title,
                destructiveHint: action.attributes.destructive,
                idempotentHint: action.attributes.idempotent,
                readOnlyHint: action.attributes.readOnly,
                openWorldHint: false,
              },
            };
          }),
        };
      } catch (err) {
        errorType = err instanceof Error ? err.name : 'Error';
        throw err;
      } finally {
        const durationSeconds = (performance.now() - startTime) / 1000;

        this.operationDuration.record(durationSeconds, {
          'mcp.method.name': 'tools/list',
          ...(errorType && { 'error.type': errorType }),
        });
      }
    });

    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const startTime = performance.now();
      let errorType: string | undefined;
      let isError = false;

      try {
        const result = await handleErrors(async () => {
          const { actions } = await this.actions.list({ credentials });
          const overrides = this.getOverrides();
          const action = this.findAction(actions, overrides, params.name);

          if (!action) {
            throw new NotFoundError(`Action "${params.name}" not found`);
          }

          const { output } = await this.actions.invoke({
            id: action.id,
            input: params.arguments as JsonObject,
            credentials,
          });

          return {
            // todo(blam): unfortunately structuredContent is not supported by most clients yet.
            // so the validation for the output happens in the default actions registry
            // and we return it as json text instead for now.
            content: [
              {
                type: 'text',
                text: ['```json', JSON.stringify(output, null, 2), '```'].join(
                  '\n',
                ),
              },
            ],
          };
        });

        isError = !!(result as { isError?: boolean })?.isError;
        return result;
      } catch (err) {
        errorType = err instanceof Error ? err.name : 'Error';
        throw err;
      } finally {
        const durationSeconds = (performance.now() - startTime) / 1000;

        // Determine error.type per OTel MCP spec:
        // - Thrown exceptions use the error name
        // - CallToolResult with isError=true uses 'tool_error'
        let errorAttribute: string | undefined = errorType;
        if (!errorAttribute && isError) {
          errorAttribute = 'tool_error';
        }

        this.operationDuration.record(durationSeconds, {
          'mcp.method.name': 'tools/call',
          'gen_ai.tool.name': params.name,
          'gen_ai.operation.name': 'execute_tool',
          ...(errorAttribute && { 'error.type': errorAttribute }),
        });
      }
    });

    return server;
  }

  private getOverrides(): Map<
    string,
    { name?: string; description?: string; title?: string }
  > {
    const overridesConfig = this.config.getOptionalConfig(
      'mcpActions.overrides',
    );

    if (!overridesConfig) {
      return new Map();
    }

    const result = new Map<
      string,
      { name?: string; description?: string; title?: string }
    >();

    for (const actionId of overridesConfig.keys()) {
      const actionConfig = overridesConfig.getConfig(actionId);
      result.set(actionId, {
        name: actionConfig.getOptionalString('name'),
        description: actionConfig.getOptionalString('description'),
        title: actionConfig.getOptionalString('title'),
      });
    }

    return result;
  }

  private findAction(
    actions: { id: string; name: string }[],
    overrides: Map<string, { name?: string }>,
    toolName: string,
  ) {
    // First check if any action has an overridden name matching the tool name
    for (const action of actions) {
      const override = overrides.get(action.id);
      if (override?.name === toolName) {
        return action;
      }
    }

    // Fall back to matching by original action name
    return actions.find(a => a.name === toolName);
  }
}
