/**
 * Cloud Code Client for Antigravity
 * 
 * Communicates with Google's Cloud Code internal API using the
 * v1internal:streamGenerateContent endpoint with proper request wrapping.
 * 
 * Based on: https://github.com/NoeFabris/opencode-antigravity-auth
 */

import crypto from 'crypto';
import { getToken, refreshToken } from './token-extractor.js';
import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    AVAILABLE_MODELS,
    DEFAULT_PROJECT_ID,
    STREAMING_CHUNK_SIZE
} from './constants.js';
import {
    mapModelName,
    convertAnthropicToGoogle,
    convertGoogleToAnthropic,
    convertStreamingChunk
} from './format-converter.js';

// Cache the project ID
let cachedProject = null;

/**
 * Get the user's cloudaicompanion project from the API
 */
export async function getProject(token) {
    if (cachedProject) {
        return cachedProject;
    }

    console.log('[CloudCode] Getting project from loadCodeAssist...');

    // Try each endpoint
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...ANTIGRAVITY_HEADERS
                },
                body: JSON.stringify({
                    metadata: {
                        ideType: 'IDE_UNSPECIFIED',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (!response.ok) {
                console.log(`[CloudCode] loadCodeAssist failed at ${endpoint}: ${response.status}`);
                continue;
            }

            const data = await response.json();

            // Extract project ID from response
            if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) {
                cachedProject = data.cloudaicompanionProject;
                console.log(`[CloudCode] Got project: ${cachedProject}`);
                return cachedProject;
            }

            if (data.cloudaicompanionProject?.id) {
                cachedProject = data.cloudaicompanionProject.id;
                console.log(`[CloudCode] Got project: ${cachedProject}`);
                return cachedProject;
            }

            console.log(`[CloudCode] No project in response from ${endpoint}`);
        } catch (error) {
            console.log(`[CloudCode] Error at ${endpoint}:`, error.message);
        }
    }

    // Use default project if discovery fails
    console.log(`[CloudCode] Using default project: ${DEFAULT_PROJECT_ID}`);
    cachedProject = DEFAULT_PROJECT_ID;
    return cachedProject;
}

/**
 * Clear the cached project
 */
export function clearProjectCache() {
    cachedProject = null;
}

/**
 * Refresh token and get project - helper to avoid duplicate logic
 */
async function refreshAndGetProject() {
    await refreshToken();
    const token = await getToken();
    clearProjectCache();
    const project = await getProject(token);
    return { token, project };
}

/**
 * Build the wrapped request body for Cloud Code API
 */
function buildCloudCodeRequest(anthropicRequest, projectId) {
    const model = mapModelName(anthropicRequest.model);
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Add session ID
    googleRequest.sessionId = '-' + Math.floor(Math.random() * 9000000000000000000).toString();

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: 'agent-' + crypto.randomUUID()
    };

    // Debug: log if tools are present
    if (googleRequest.tools) {
        console.log('[CloudCode] Tools in request:', JSON.stringify(googleRequest.tools).substring(0, 500));
    }

    return payload;
}

/**
 * Send a non-streaming request to Cloud Code
 */
export async function sendMessage(anthropicRequest) {
    let token = await getToken();
    let project;

    try {
        project = await getProject(token);
    } catch (err) {
        console.log('[CloudCode] Project fetch failed, refreshing token...');
        ({ token, project } = await refreshAndGetProject());
    }

    const model = mapModelName(anthropicRequest.model);
    const payload = buildCloudCodeRequest(anthropicRequest, project);

    console.log(`[CloudCode] Sending request for model: ${model}`);

    // Try each endpoint
    let lastError = null;
    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:generateContent`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...ANTIGRAVITY_HEADERS
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.log(`[CloudCode] Error at ${endpoint}: ${response.status} - ${errorText}`);

                // Handle auth errors
                if (response.status === 401) {
                    console.log('[CloudCode] Auth error, refreshing token...');
                    ({ token, project } = await refreshAndGetProject());
                    // Retry with new token
                    payload.project = project;
                    continue;
                }

                // Handle rate limiting
                if (response.status === 429) {
                    lastError = new Error(`Rate limited: ${errorText}`);
                    continue;
                }

                // Try next endpoint for 4xx/5xx errors
                if (response.status >= 400) {
                    lastError = new Error(`API error ${response.status}: ${errorText}`);
                    continue;
                }
            }

            const data = await response.json();
            console.log('[CloudCode] Response received');

            return convertGoogleToAnthropic(data, anthropicRequest.model);

        } catch (error) {
            console.log(`[CloudCode] Error at ${endpoint}:`, error.message);
            lastError = error;
        }
    }

    throw lastError || new Error('All endpoints failed');
}

/**
 * Send a streaming request to Cloud Code
 * Note: Antigravity's streaming API doesn't actually stream text incrementally,
 * so we use the non-streaming API and simulate SSE events for client compatibility.
 */
export async function* sendMessageStream(anthropicRequest) {
    // Get the full response first
    const fullResponse = await sendMessage(anthropicRequest);

    console.log('[CloudCode] Simulating stream from full response');

    // Emit message_start
    yield {
        type: 'message_start',
        message: {
            id: fullResponse.id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: fullResponse.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: fullResponse.usage?.input_tokens || 0, output_tokens: 0 }
        }
    };

    // Process each content block
    let blockIndex = 0;
    for (const block of fullResponse.content) {
        if (block.type === 'text') {
            // content_block_start
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' }
            };

            // Stream text in chunks for a more realistic streaming experience
            const text = block.text;

            for (let i = 0; i < text.length; i += STREAMING_CHUNK_SIZE) {
                const chunk = text.slice(i, i + STREAMING_CHUNK_SIZE);
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: chunk }
                };
            }

            // content_block_stop
            yield {
                type: 'content_block_stop',
                index: blockIndex
            };

            blockIndex++;

        } else if (block.type === 'tool_use') {
            // content_block_start for tool_use
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: {}
                }
            };

            // Send input as delta
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify(block.input)
                }
            };

            // content_block_stop
            yield {
                type: 'content_block_stop',
                index: blockIndex
            };

            blockIndex++;
        }
    }

    // message_delta
    yield {
        type: 'message_delta',
        delta: {
            stop_reason: fullResponse.stop_reason,
            stop_sequence: fullResponse.stop_sequence
        },
        usage: { output_tokens: fullResponse.usage?.output_tokens || 0 }
    };

    // message_stop
    yield { type: 'message_stop' };
}

/**
 * List available models
 */
export function listModels() {
    return {
        object: 'list',
        data: AVAILABLE_MODELS.map(m => ({
            id: m.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: m.description
        }))
    };
}

export default {
    sendMessage,
    sendMessageStream,
    listModels,
    clearProjectCache,
    getProject
};
