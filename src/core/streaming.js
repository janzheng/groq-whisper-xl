import { streamLogger, formatBytes, withExponentialRetry } from './logger.js';
import { withTranscriptionLimits, withLLMLimits } from './rate-limiter.js';

// ============================================================================
// STREAMING API - Emulates Groq's streaming chat completion format
// ============================================================================

/**
 * Streaming transcription that processes audio in tiny chunks and returns results as SSE stream
 * Similar to Groq's chat completion streaming API
 * 
 * curl -X POST http://localhost:8787/stream \
 *   -H "Content-Type: application/json" \
 *   -d '{"url": "https://example.com/audio.mp3", "chunk_size_mb": 1, "use_llm": true, "model": "whisper-large-v3"}'
 * 
 * Or with file upload:
 * curl -X POST http://localhost:8787/stream \
 *   -F "file=@audio.mp3" \
 *   -F "chunk_size_mb=1" \
 *   -F "use_llm=true" \
 *   -F "model=whisper-large-v3"
 * 
 * Note: LLM correction is disabled by default for streaming. Set use_llm=true to enable.
 */
export async function handleStreamingTranscription(request, env) {
  const contentType = request.headers.get('content-type') || '';
  let audioData, filename, chunkSizeMB = 0.25, use_llm = false, llm_mode = 'per_chunk', model = 'whisper-large-v3';
  
  try {
    // Parse request data
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file');
      
      if (!file || !file.name) {
        return new Response('data: {"error": "No file provided"}\n\n', { 
          status: 400,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      filename = file.name;
      audioData = await file.arrayBuffer();
      chunkSizeMB = parseFloat(formData.get('chunk_size_mb')) || 0.25;
      use_llm = formData.get('use_llm') === 'true'; // Explicitly false by default
      llm_mode = formData.get('llm_mode') || 'per_chunk'; // 'per_chunk' or 'post_process'
      model = formData.get('model') || 'whisper-large-v3';
      
    } else if (contentType.includes('application/json')) {
      const body = await request.json();
      
      if (body.url) {
        // Download from URL
        try {
          const response = await fetch(body.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Groq-Whisper-XL/1.0)',
              'Accept': 'audio/*, video/*, */*'
            },
            signal: AbortSignal.timeout(30000)
          });
          
          if (!response.ok) {
            return createStreamError(`Failed to fetch audio: ${response.status}`);
          }
          
          audioData = await response.arrayBuffer();
          filename = body.url.split('/').pop() || 'audio.mp3';
          
        } catch (error) {
          return createStreamError(`URL fetch failed: ${error.message}`);
        }
        
      } else if (body.file_data) {
        // Base64 encoded data
        try {
          audioData = Uint8Array.from(atob(body.file_data), c => c.charCodeAt(0)).buffer;
          filename = body.filename || 'audio.mp3';
        } catch (error) {
          return createStreamError('Invalid base64 file_data');
        }
        
      } else {
        return createStreamError('Either url or file_data is required');
      }
      
      chunkSizeMB = body.chunk_size_mb || 0.25;
      use_llm = body.use_llm === true; // Explicitly require true, default false
      llm_mode = body.llm_mode || 'per_chunk'; // 'per_chunk' or 'post_process'
      model = body.model || 'whisper-large-v3';
      
    } else {
      return createStreamError('Content-Type must be multipart/form-data or application/json');
    }
    
    // Create job record for streaming transcription
    const job_id = crypto.randomUUID();
    const job = {
      status: 'streaming',
      filename,
      size: audioData.byteLength,
      actual_size: audioData.byteLength,
      processing_method: 'streaming',
      use_llm,
      llm_mode,
      model,
      chunk_size_mb: chunkSizeMB,
      created_at: new Date().toISOString(),
      processing_started_at: new Date().toISOString()
    };
    
    // Store initial job state
    await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
    
    // Create a ReadableStream for Server-Sent Events with aggressive flushing
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await processAudioStreamChunks(
            new Uint8Array(audioData), 
            filename, 
            chunkSizeMB, 
            use_llm, 
            llm_mode,
            model,
            controller, 
            env,
            job_id  // Pass job_id for progress tracking
          );
        } catch (error) {
          const errorData = createStreamChunk('error', { error: error.message });
          controller.enqueue(new TextEncoder().encode(errorData));
          
          // Update job status to failed
          const failedJob = { ...job, status: 'failed', error: error.message, failed_at: new Date().toISOString() };
          await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(failedJob), { expirationTtl: 86400 });
        } finally {
          controller.close();
        }
      }
    });
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
    
  } catch (error) {
    return createStreamError(`Streaming setup failed: ${error.message}`);
  }
}

export async function processAudioStreamChunks(audioBuffer, filename, chunkSizeMB, use_llm, llm_mode, model, controller, env, job_id = null) {
  const chunkSize = chunkSizeMB * 1024 * 1024; // Convert MB to bytes
  const ext = filename.split('.').pop() || 'mp3';
  
  // Send initial status
  streamLogger.info('stream', 'Starting streaming transcription', {
    filename,
    total_size: formatBytes(audioBuffer.length),
    chunk_size: formatBytes(chunkSize),
    estimated_chunks: Math.ceil(audioBuffer.length / chunkSize),
    llm_mode: use_llm ? llm_mode : 'disabled',
    model
  });
  
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('status', { 
      message: 'Starting transcription',
      job_id,
      filename,
      total_size: audioBuffer.length,
      chunk_size: chunkSize,
      estimated_chunks: Math.ceil(audioBuffer.length / chunkSize),
      llm_mode: use_llm ? llm_mode : 'disabled',
      model
    })
  ));
  
  // Create tiny chunks for streaming
  const chunks = createTinyChunks(audioBuffer, chunkSize);
  let fullTranscript = '';
  let correctedTranscript = '';
  const segments = [];
  
  // Send chunk info
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('chunk_info', { 
      total_chunks: chunks.length,
      chunk_size_mb: chunkSizeMB,
      llm_correction: use_llm ? llm_mode : 'disabled',
      model
    })
  ));
  
  // Process each chunk and stream results
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    try {
      // Send chunk start event  
      const chunkStartData = createStreamChunk('chunk_start', { 
        chunk_index: i,
        chunk_size: chunk.data.length,
        progress: Math.round((i / chunks.length) * 100)
      });
      controller.enqueue(new TextEncoder().encode(chunkStartData));
      
      // Transcribe chunk with the specified model
      const transcript = await transcribeChunk(chunk.data, ext, env.GROQ_API_KEY, model);
      
      if (transcript.text) {
        let correctedText = transcript.text;
        
        // Apply per-chunk LLM correction if enabled
        if (use_llm && llm_mode === 'per_chunk') {
          try {
            correctedText = await applyPerChunkLLMCorrection(transcript.text, env.GROQ_API_KEY);
            
            // Send delta with both raw and corrected text
            controller.enqueue(new TextEncoder().encode(
              createStreamChunk('delta', { 
                chunk_index: i,
                raw_text: transcript.text,
                corrected_text: correctedText,
                segments: transcript.segments || [],
                llm_applied: true,
                groq_response: transcript // Preserve full Groq response
              })
            ));
            
          } catch (llmError) {
            // LLM failed, send raw text only with error info
            controller.enqueue(new TextEncoder().encode(
              createStreamChunk('delta', { 
                chunk_index: i,
                raw_text: transcript.text,
                corrected_text: transcript.text, // fallback to raw
                segments: transcript.segments || [],
                llm_applied: false,
                llm_error: llmError.message,
                groq_response: transcript // Preserve full Groq response
              })
            ));
            correctedText = transcript.text; // use raw text as fallback
          }
        } else {
          // No LLM, send raw text
          controller.enqueue(new TextEncoder().encode(
            createStreamChunk('delta', { 
              chunk_index: i,
              raw_text: transcript.text,
              text: transcript.text,
              segments: transcript.segments || [],
              llm_applied: false,
              groq_response: transcript // Preserve full Groq response
            })
          ));
        }
        
        // Accumulate transcripts
        fullTranscript += (fullTranscript ? ' ' : '') + transcript.text;
        correctedTranscript += (correctedTranscript ? ' ' : '') + correctedText;
        
        // Collect all segments
        if (transcript.segments) {
          segments.push(...transcript.segments);
        }
      }
      
      // Send chunk completion
      const chunkDoneData = createStreamChunk('chunk_done', { 
        chunk_index: i,
        progress: Math.round(((i + 1) / chunks.length) * 100)
      });
      controller.enqueue(new TextEncoder().encode(chunkDoneData));
      
    } catch (error) {
      streamLogger.error(`Chunk ${i} failed`, error);
      
      // Send chunk error
      const chunkErrorData = createStreamChunk('chunk_error', { 
        chunk_index: i,
        error: error.message,
        progress: Math.round(((i + 1) / chunks.length) * 100)
      });
      controller.enqueue(new TextEncoder().encode(chunkErrorData));
    }
  }
  
  // Apply post-processing LLM if requested
  let finalTranscript = fullTranscript;
  
  if (use_llm && llm_mode === 'post_process') {
    controller.enqueue(new TextEncoder().encode(
      createStreamChunk('llm_processing', { 
        message: 'Applying LLM corrections to full transcript...',
        mode: 'post_process'
      })
    ));
    
    try {
      finalTranscript = await applyLLMCorrection(fullTranscript, env.GROQ_API_KEY);
      
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('llm_done', { 
          corrected_text: finalTranscript,
          mode: 'post_process'
        })
      ));
    } catch (error) {
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('llm_error', { 
          error: error.message,
          fallback_text: fullTranscript,
          mode: 'post_process'
        })
      ));
    }
  } else if (use_llm && llm_mode === 'per_chunk') {
    finalTranscript = correctedTranscript;
  }
  
  // Send final completion
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('done', { 
      job_id,
      final_transcript: finalTranscript,
      raw_transcript: fullTranscript,
      corrected_transcript: use_llm && llm_mode === 'per_chunk' ? correctedTranscript : null,
      total_segments: segments.length,
      processing_completed: true,
      llm_correction_applied: use_llm,
      llm_mode: use_llm ? llm_mode : 'disabled',
      model
    })
  ));
  
  // Update job status to completed if job_id provided
  if (job_id && env.GROQ_JOBS_KV) {
    try {
      const jobData = await env.GROQ_JOBS_KV.get(job_id);
      if (jobData) {
        const job = JSON.parse(jobData);
        job.status = 'done';
        job.final_transcript = finalTranscript;
        job.raw_transcript = fullTranscript;
        job.corrected_transcript = use_llm && llm_mode === 'per_chunk' ? correctedTranscript : null;
        job.total_segments = segments.length;
        job.completed_at = new Date().toISOString();
        job.llm_correction_applied = use_llm;
        job.model = model;
        job.transcripts = [{ 
          text: finalTranscript, 
          raw_text: fullTranscript,
          segments: segments,
          start: 0,
          duration: audioBuffer.length,
          chunk_index: 'streaming',
          model
        }];
        
        await env.GROQ_JOBS_KV.put(job_id, JSON.stringify(job), { expirationTtl: 86400 });
        streamLogger.complete('Streaming job completed and saved', { 
          job_id, 
          filename,
          model,
          transcript_length: finalTranscript?.length || 0
        });
      }
    } catch (error) {
      streamLogger.error('Failed to update streaming job completion', error, { job_id });
    }
  }
}

export function createTinyChunks(buffer, chunkSize) {
  const chunks = [];
  const minOverlap = Math.min(1024 * 50, Math.floor(chunkSize * 0.02)); // 50KB or 2% overlap
  
  for (let start = 0; start < buffer.length; start += chunkSize - minOverlap) {
    const end = Math.min(start + chunkSize, buffer.length);
    const chunkData = buffer.slice(start, end);
    
    chunks.push({
      start,
      end,
      data: chunkData,
      size: chunkData.length
    });
    
    if (end >= buffer.length) break;
  }
  
  return chunks;
}

export function createStreamChunk(type, data) {
  return `data: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function createStreamError(message) {
  return new Response(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`, {
    status: 400,
    headers: { 'Content-Type': 'text/plain' }
  });
}

/**
 * Per-chunk LLM correction using Llama 3.1 8B Instant for real-time streaming
 * Optimized for speed and cost-effectiveness with shorter, focused prompts
 */
export async function applyPerChunkLLMCorrection(text, apiKey) {
  try {
    // Skip LLM for very short chunks (not worth the API call)
    if (text.trim().length < 10) {
      return text;
    }
    
    return await withLLMLimits(async () => {
      const result = await withExponentialRetry(async () => {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${apiKey}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{
              role: 'user',
              content: `Fix punctuation and obvious errors in this audio transcript chunk. Output ONLY the corrected text with no preamble or explanatory text:\n\n"${text}"`
            }],
            temperature: 0.1,
            max_tokens: 150, // Smaller limit for chunks
            stream: false
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const error = new Error(`LLM API error: ${response.status} ${response.statusText}`);
          error.status = response.status;
          error.response = { status: response.status };
          error.details = errorData;
          throw error;
        }
        
        return await response.json();
      }, {
        maxRetries: 3, // Fewer retries for per-chunk processing to maintain speed
        baseDelay: 500,
        maxDelay: 5000
      });
      
      const correctedText = result.choices[0].message.content.trim();
      
      // Remove quotes if LLM added them
      return correctedText.replace(/^["']|["']$/g, '');
    }, {
      text_length: text.length,
      operation: 'per_chunk_llm_correction'
    });
    
  } catch (error) {
    streamLogger.error('Per-chunk LLM correction failed after retries', error, { 
      text_length: text?.length || 0 
    });
    throw error; // Let the caller handle the error
  }
}

/**
 * Simple LLM correction using Groq (for post-processing)
 */
export async function applyLLMCorrection(text, apiKey) {
  try {
    return await withLLMLimits(async () => {
      const result = await withExponentialRetry(async () => {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${apiKey}`, 
            'Content-Type': 'application/json' 
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{
              role: 'user',
              content: `Fix speech recognition errors, improve punctuation, and make this transcript more readable while preserving the original meaning and style. Output ONLY the corrected transcript with no preamble, introduction, or explanatory text:\n\n${text}`
            }],
            temperature: 0.1,
            max_tokens: 131072
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          const error = new Error(`LLM API error: ${response.status} ${response.statusText}`);
          error.status = response.status;
          error.response = { status: response.status };
          error.details = errorData;
          throw error;
        }
        
        return await response.json();
      });
      
      return result.choices[0].message.content;
    }, {
      text_length: text.length,
      operation: 'full_llm_correction'
    });
  } catch (error) {
    streamLogger.error('LLM correction failed after retries', error, { 
      original_length: text?.length || 0 
    });
    return text; // Return original if correction fails
  }
}

export async function transcribeChunk(data, ext, apiKey, model = 'whisper-large-v3') {
  return await withTranscriptionLimits(async () => {
    const result = await withExponentialRetry(async () => {
      const formData = new FormData();
      formData.append('file', new Blob([data]), `chunk.${ext}`);
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(`Groq Transcription API error: ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.response = { status: response.status };
        error.details = errorData;
        throw error;
      }
      
      return await response.json();
    }, {
      maxRetries: 5, // More retries for core transcription
      baseDelay: 1000,
      maxDelay: 15000,
      // Be more aggressive with retrying transcription errors
      retryableErrors: ['rate_limit', 'temporary_failure', 'network_error', 'timeout', 'client_error']
    });
    
    // Preserve the full response from Groq for debugging and tracing
    if (result.error) {
      throw new Error(`Groq API error: ${result.error.message || result.error}`);
    }
    
    return result;
  }, {
    model,
    data_size: data.length,
    extension: ext
  });
} 