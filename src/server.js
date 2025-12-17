/**
 * Express Server - Anthropic-compatible API
 * Proxies to Google Cloud Code via Antigravity
 */

import express from 'express';
import cors from 'cors';
import { sendMessage, sendMessageStream, listModels, clearProjectCache, getProject } from './cloudcode-client.js';
import { getToken, forceRefresh } from './token-extractor.js';
import { AVAILABLE_MODELS, REQUEST_BODY_LIMIT } from './constants.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

/**
 * Parse error message to extract error type, status code, and user-friendly message
 */
function parseError(error) {
    let errorType = 'api_error';
    let statusCode = 500;
    let errorMessage = error.message;

    if (error.message.includes('401') || error.message.includes('UNAUTHENTICATED')) {
        errorType = 'authentication_error';
        statusCode = 401;
        errorMessage = 'Authentication failed. Make sure Antigravity is running with a valid token.';
    } else if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')) {
        errorType = 'rate_limit_error';
        statusCode = 429;
        const resetMatch = error.message.match(/quota will reset after (\d+h\d+m\d+s|\d+s)/i);
        errorMessage = resetMatch
            ? `Rate limited. Quota will reset after ${resetMatch[1]}.`
            : 'Rate limited. Please wait and try again.';
    } else if (error.message.includes('invalid_request_error') || error.message.includes('INVALID_ARGUMENT')) {
        errorType = 'invalid_request_error';
        statusCode = 400;
        const msgMatch = error.message.match(/"message":"([^"]+)"/);
        if (msgMatch) errorMessage = msgMatch[1];
    } else if (error.message.includes('All endpoints failed')) {
        errorType = 'api_error';
        statusCode = 503;
        errorMessage = 'Unable to connect to Claude API. Check that Antigravity is running.';
    } else if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'permission_error';
        statusCode = 403;
        errorMessage = 'Permission denied. Check your Antigravity license.';
    }

    return { errorType, statusCode, errorMessage };
}

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    try {
        const token = await getToken();
        let project = null;
        try {
            project = await getProject(token);
        } catch (e) {
            // Project fetch might fail if token just refreshed
        }

        res.json({
            status: 'ok',
            hasToken: !!token,
            tokenPrefix: token ? token.substring(0, 10) + '...' : null,
            project: project || 'unknown',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * Force token refresh endpoint
 */
app.post('/refresh-token', async (req, res) => {
    try {
        clearProjectCache();
        const token = await forceRefresh();
        res.json({
            status: 'ok',
            message: 'Token refreshed successfully',
            tokenPrefix: token.substring(0, 10) + '...'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * List models endpoint (OpenAI-compatible format)
 */
app.get('/v1/models', (req, res) => {
    res.json(listModels());
});

/**
 * Main messages endpoint - Anthropic Messages API compatible
 */
app.post('/v1/messages', async (req, res) => {
    try {
        const {
            model,
            messages,
            max_tokens,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        } = req.body;

        // Validate required fields
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'messages is required and must be an array'
                }
            });
        }

        // Build the request object
        const request = {
            model: model || 'claude-3-5-sonnet-20241022',
            messages,
            max_tokens: max_tokens || 4096,
            stream,
            system,
            tools,
            tool_choice,
            thinking,
            top_p,
            top_k,
            temperature
        };

        console.log(`[API] Request for model: ${request.model}, stream: ${!!stream}`);

        if (stream) {
            // Handle streaming response
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            try {
                // Use the streaming generator
                for await (const event of sendMessageStream(request)) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                }
                res.end();

            } catch (streamError) {
                console.error('[API] Stream error:', streamError);

                const { errorType, errorMessage } = parseError(streamError);

                res.write(`event: error\ndata: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: errorMessage }
                })}\n\n`);
                res.end();
            }

        } else {
            // Handle non-streaming response
            const response = await sendMessage(request);
            res.json(response);
        }

    } catch (error) {
        console.error('[API] Error:', error);

        let { errorType, statusCode, errorMessage } = parseError(error);

        // For auth errors, try to refresh token
        if (errorType === 'authentication_error') {
            console.log('[API] Token might be expired, attempting refresh...');
            try {
                clearProjectCache();
                await forceRefresh();
                errorMessage = 'Token was expired and has been refreshed. Please retry your request.';
            } catch (refreshError) {
                errorMessage = 'Could not refresh token. Make sure Antigravity is running.';
            }
        }

        res.status(statusCode).json({
            type: 'error',
            error: {
                type: errorType,
                message: errorMessage
            }
        });
    }
});

/**
 * Catch-all for unsupported endpoints
 */
app.use('*', (req, res) => {
    res.status(404).json({
        type: 'error',
        error: {
            type: 'not_found_error',
            message: `Endpoint ${req.method} ${req.originalUrl} not found`
        }
    });
});

export default app;
