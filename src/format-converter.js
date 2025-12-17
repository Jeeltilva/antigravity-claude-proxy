/**
 * Format Converter
 * Converts between Anthropic Messages API format and Google Generative AI format
 * 
 * Based on patterns from:
 * - https://github.com/NoeFabris/opencode-antigravity-auth
 * - https://github.com/1rgs/claude-code-proxy
 */

import crypto from 'crypto';
import { MODEL_MAPPINGS } from './constants.js';

/**
 * Map Anthropic model name to Antigravity model name
 */
export function mapModelName(anthropicModel) {
    return MODEL_MAPPINGS[anthropicModel] || anthropicModel;
}

/**
 * Convert Anthropic message content to Google Generative AI parts
 */
function convertContentToParts(content, isClaudeModel = false) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ text: String(content) }];
    }

    const parts = [];

    for (const block of content) {
        if (block.type === 'text') {
            parts.push({ text: block.text });
        } else if (block.type === 'image') {
            // Handle image content
            if (block.source?.type === 'base64') {
                // Base64-encoded image
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                // URL-referenced image
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'image/jpeg',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'document') {
            // Handle document content (e.g. PDF)
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'application/pdf',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'tool_use') {
            // Convert tool_use to functionCall (Google format)
            // For Claude models, include the id field
            const functionCall = {
                name: block.name,
                args: block.input || {}
            };

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
            }

            parts.push({ functionCall });
        } else if (block.type === 'tool_result') {
            // Convert tool_result to functionResponse (Google format)
            let responseContent = block.content;
            if (typeof responseContent === 'string') {
                responseContent = { result: responseContent };
            } else if (Array.isArray(responseContent)) {
                const texts = responseContent
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                responseContent = { result: texts };
            }

            const functionResponse = {
                name: block.tool_use_id || 'unknown',
                response: responseContent
            };

            // For Claude models, the id field must match the tool_use_id
            if (isClaudeModel && block.tool_use_id) {
                functionResponse.id = block.tool_use_id;
            }

            parts.push({ functionResponse });
        } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Skip thinking blocks for Claude models - thinking is handled by the model itself
            // For non-Claude models, convert to Google's thought format
            if (!isClaudeModel && block.type === 'thinking') {
                parts.push({
                    text: block.thinking,
                    thought: true
                });
            }
        }
    }

    return parts.length > 0 ? parts : [{ text: '' }];
}

/**
 * Convert Anthropic role to Google role
 */
function convertRole(role) {
    if (role === 'assistant') return 'model';
    if (role === 'user') return 'user';
    return 'user'; // Default to user
}

/**
 * Convert Anthropic Messages API request to the format expected by Cloud Code
 * 
 * Uses Google Generative AI format, but for Claude models:
 * - Keeps tool_result in Anthropic format (required by Claude API)
 * 
 * @param {Object} anthropicRequest - Anthropic format request
 * @returns {Object} Request body for Cloud Code API
 */
export function convertAnthropicToGoogle(anthropicRequest) {
    const { messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking } = anthropicRequest;
    const isClaudeModel = (anthropicRequest.model || '').toLowerCase().includes('claude');

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    // Handle system instruction
    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            // Filter for text blocks as system prompts are usually text
            // Anthropic supports text blocks in system prompts
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    // Convert messages to contents
    for (const msg of messages) {
        const parts = convertContentToParts(msg.content, isClaudeModel);
        const content = {
            role: convertRole(msg.role),
            parts: parts
        };
        googleRequest.contents.push(content);
    }

    // Generation config
    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    // Extended thinking is disabled for Claude models
    // The model itself (e.g., claude-opus-4-5-thinking) handles thinking internally
    // Enabling thinkingConfig causes signature issues in multi-turn conversations

    // Convert tools to Google format
    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            // Extract name from various possible locations
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;

            // Extract description from various possible locations
            const description = tool.description || tool.function?.description || tool.custom?.description || '';

            // Extract schema from various possible locations
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters: sanitizeSchema(schema)
            };
        });

        googleRequest.tools = [{ functionDeclarations }];
        console.log('[FormatConverter] Tools:', JSON.stringify(googleRequest.tools).substring(0, 300));
    }

    return googleRequest;
}

/**
 * Sanitize JSON schema for Google API compatibility
 * Removes unsupported fields like additionalProperties
 */
function sanitizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    // Fields to skip entirely - not compatible with Claude's JSON Schema 2020-12
    const UNSUPPORTED_FIELDS = new Set([
        '$schema',
        'additionalProperties',
        'default',
        'anyOf',
        'allOf',
        'oneOf',
        'minLength',
        'maxLength',
        'pattern',
        'format',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minItems',
        'maxItems',
        'uniqueItems',
        'minProperties',
        'maxProperties',
        '$id',
        '$ref',
        '$defs',
        'definitions',
        'patternProperties',
        'unevaluatedProperties',
        'unevaluatedItems',
        'if',
        'then',
        'else',
        'not',
        'contentEncoding',
        'contentMediaType'
    ]);

    const sanitized = {};
    for (const [key, value] of Object.entries(schema)) {
        // Skip unsupported fields
        if (UNSUPPORTED_FIELDS.has(key)) {
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object') {
            sanitized.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                sanitized.properties[propKey] = sanitizeSchema(propValue);
            }
        } else if (key === 'items' && value && typeof value === 'object') {
            // Handle items - could be object or array
            if (Array.isArray(value)) {
                sanitized.items = value.map(item => sanitizeSchema(item));
            } else if (value.anyOf || value.allOf || value.oneOf) {
                // Replace complex items with permissive type
                sanitized.items = {};
            } else {
                sanitized.items = sanitizeSchema(value);
            }
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Recursively sanitize nested objects that aren't properties/items
            sanitized[key] = sanitizeSchema(value);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * Convert Google Generative AI response to Anthropic Messages API format
 * 
 * @param {Object} googleResponse - Google format response (the inner response object)
 * @param {string} model - The model name used
 * @param {boolean} isStreaming - Whether this is a streaming response
 * @returns {Object} Anthropic format response
 */
export function convertGoogleToAnthropic(googleResponse, model, isStreaming = false) {
    // Handle the response wrapper
    const response = googleResponse.response || googleResponse;

    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];

    // Convert parts to Anthropic content blocks
    const anthropicContent = [];
    let toolCallCounter = 0;

    for (const part of parts) {
        if (part.text !== undefined) {
            // Skip thinking blocks (thought: true) - the model handles thinking internally
            if (part.thought === true) {
                continue;
            }
            anthropicContent.push({
                type: 'text',
                text: part.text
            });
        } else if (part.functionCall) {
            // Convert functionCall to tool_use
            // Use the id from the response if available, otherwise generate one
            anthropicContent.push({
                type: 'tool_use',
                id: part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                name: part.functionCall.name,
                input: part.functionCall.args || {}
            });
            toolCallCounter++;
        }
    }

    // Determine stop reason
    const finishReason = firstCandidate.finishReason;
    let stopReason = 'end_turn';
    if (finishReason === 'STOP') {
        stopReason = 'end_turn';
    } else if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'TOOL_USE' || toolCallCounter > 0) {
        stopReason = 'tool_use';
    }

    // Extract usage metadata
    const usageMetadata = response.usageMetadata || {};

    return {
        id: `msg_${crypto.randomBytes(16).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: usageMetadata.promptTokenCount || 0,
            output_tokens: usageMetadata.candidatesTokenCount || 0
        }
    };
}

/**
 * Parse SSE data and extract the response object
 */
export function parseSSEResponse(data) {
    if (!data || !data.startsWith('data:')) {
        return null;
    }

    const jsonStr = data.slice(5).trim();
    if (!jsonStr) {
        return null;
    }

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error('[FormatConverter] Failed to parse SSE data:', e.message);
        return null;
    }
}

/**
 * Convert a streaming chunk to Anthropic SSE format
 */
export function convertStreamingChunk(googleChunk, model, index, isFirst, isLast) {
    const events = [];
    const response = googleChunk.response || googleChunk;
    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];

    if (isFirst) {
        // message_start event
        events.push({
            type: 'message_start',
            message: {
                id: `msg_${crypto.randomBytes(16).toString('hex')}`,
                type: 'message',
                role: 'assistant',
                content: [],
                model: model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });

        // content_block_start event
        events.push({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
        });
    }

    // Extract text from parts and emit as delta
    for (const part of parts) {
        if (part.text !== undefined) {
            events.push({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: part.text }
            });
        }
    }

    if (isLast) {
        // content_block_stop event
        events.push({
            type: 'content_block_stop',
            index: 0
        });

        // Determine stop reason
        const finishReason = firstCandidate.finishReason;
        let stopReason = 'end_turn';
        if (finishReason === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
        }

        // Extract usage
        const usageMetadata = response.usageMetadata || {};

        // message_delta event
        events.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usageMetadata.candidatesTokenCount || 0 }
        });

        // message_stop event
        events.push({ type: 'message_stop' });
    }

    return events;
}

export default {
    mapModelName,
    convertAnthropicToGoogle,
    convertGoogleToAnthropic,
    parseSSEResponse,
    convertStreamingChunk
};
