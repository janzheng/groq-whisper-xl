import { ParentJobManager } from '../core/parent-job-manager.js';
import { ChunkAssembler } from '../core/chunk-assembly.js';
import { streamLogger } from '../../core/logger.js';

/**
 * Handler for /chunked-stream/{parent_job_id} endpoint
 * Provides real-time SSE updates for chunked upload streaming
 */

/**
 * Stream real-time updates for a chunked upload session
 * 
 * curl -N http://localhost:8787/chunked-stream/{parent_job_id}
 */
export async function handleChunkedStream(request, env, parent_job_id) {
  try {
    // Validate parent job exists
    const parentJobManager = new ParentJobManager(env);
    const chunkAssembler = new ChunkAssembler(env);
    
    let parentJob;
    try {
      parentJob = await parentJobManager.getParentJob(parent_job_id);
    } catch (error) {
      return new Response(`data: ${JSON.stringify({ 
        type: 'error', 
        error: 'Parent job not found',
        parent_job_id 
      })}\n\n`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    streamLogger.info('stream', 'Starting chunked upload stream', {
      parent_job_id,
      filename: parentJob.filename,
      total_chunks: parentJob.total_chunks,
      status: parentJob.status
    });

    // Create SSE stream
    const stream = new ReadableStream({
      async start(controller) {
        try {
          await streamChunkedUploadUpdates(
            parent_job_id,
            parentJob,
            controller,
            env,
            parentJobManager,
            chunkAssembler
          );
        } catch (error) {
          const errorData = createStreamChunk('error', { 
            error: error.message,
            parent_job_id 
          });
          controller.enqueue(new TextEncoder().encode(errorData));
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });

  } catch (error) {
    streamLogger.error('Failed to create chunked stream', error, { parent_job_id });
    return new Response(`data: ${JSON.stringify({ 
      type: 'error', 
      error: 'Failed to create stream',
      message: error.message 
    })}\n\n`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Stream updates for chunked upload progress
 */
async function streamChunkedUploadUpdates(
  parent_job_id, 
  initialParentJob, 
  controller, 
  env, 
  parentJobManager,
  chunkAssembler
) {
  let parentJob = initialParentJob;
  let lastAssembledIndex = -1;
  const maxPollingDuration = 30 * 60 * 1000; // 30 minutes
  const pollingInterval = 2000; // 2 seconds
  
  const startTime = Date.now();

  // Send initial status
  controller.enqueue(new TextEncoder().encode(
    createStreamChunk('initialized', {
      parent_job_id,
      filename: parentJob.filename,
      status: parentJob.status,
      total_chunks: parentJob.total_chunks,
      uploaded_chunks: parentJob.uploaded_chunks,
      completed_chunks: parentJob.completed_chunks,
      processing_options: {
        use_llm: parentJob.use_llm,
        llm_mode: parentJob.llm_mode,
        chunk_size_mb: parentJob.chunk_size_mb
      },
      estimated_completion: parentJob.estimated_completion || null
    })
  ));

  // Main polling loop
  while (Date.now() - startTime < maxPollingDuration) {
    try {
      // Get updated parent job status
      const updatedJob = await parentJobManager.getParentJob(parent_job_id);
      const hasUpdates = JSON.stringify(updatedJob) !== JSON.stringify(parentJob);
      
      if (hasUpdates) {
        parentJob = updatedJob;
        
        // Send progress update
        controller.enqueue(new TextEncoder().encode(
          createStreamChunk('progress_update', {
            parent_job_id,
            status: parentJob.status,
            progress: parentJob.progress,
            upload_progress: parentJob.upload_progress,
            processing_progress: parentJob.processing_progress,
            uploaded_chunks: parentJob.uploaded_chunks,
            completed_chunks: parentJob.completed_chunks,
            failed_chunks: parentJob.failed_chunks,
            success_rate: parentJob.success_rate || 0
          })
        ));

        // Check for new completed chunks to stream partial results
        if (parentJob.transcripts && parentJob.transcripts.length > 0) {
          const streamingAssembly = chunkAssembler.getStreamingAssembly(
            parentJob.transcripts, 
            lastAssembledIndex
          );

          if (streamingAssembly.hasNewContent) {
            controller.enqueue(new TextEncoder().encode(
              createStreamChunk('partial_transcript', {
                parent_job_id,
                partial_transcript: streamingAssembly.partialTranscript,
                available_chunks: streamingAssembly.availableChunks,
                total_chunks: streamingAssembly.totalChunks,
                last_assembled_index: streamingAssembly.lastIndex
              })
            ));
            
            lastAssembledIndex = streamingAssembly.lastIndex;
          }
        }

        // Stream individual chunk completions - handle out-of-order completion
        if (parentJob.transcripts && parentJob.transcripts.length > 0) {
          let hasNewlyStreamedChunks = false;
          
          for (let i = 0; i < parentJob.transcripts.length; i++) {
            const chunk = parentJob.transcripts[i];
            
            // Check if this chunk is newly completed and hasn't been streamed yet
            if (chunk && !chunk.streamed && !chunk.failed && chunk.text) {
              controller.enqueue(new TextEncoder().encode(
                createStreamChunk('chunk_complete', {
                  parent_job_id,
                  chunk_index: i,
                  text: chunk.text,
                  raw_text: chunk.raw_text || chunk.text,
                  corrected_text: chunk.corrected_text,
                  llm_applied: chunk.llm_applied || false,
                  processing_time: chunk.processing_time || 0
                })
              ));
              
              // Mark as streamed to avoid duplicate events
              chunk.streamed = true;
              parentJob.transcripts[i] = chunk;
              hasNewlyStreamedChunks = true;
              
            } else if (chunk && !chunk.streamed && chunk.failed) {
              controller.enqueue(new TextEncoder().encode(
                createStreamChunk('chunk_failed', {
                  parent_job_id,
                  chunk_index: i,
                  error: chunk.error
                })
              ));
              
              // Mark as streamed to avoid duplicate events
              chunk.streamed = true;
              parentJob.transcripts[i] = chunk;
              hasNewlyStreamedChunks = true;
            }
          }
          
          // Save parent job if we marked any chunks as streamed
          if (hasNewlyStreamedChunks) {
            await parentJobManager.updateParentJob(parent_job_id, parentJob);
          }
        }
      }

      // Check if job is complete
      if (parentJob.status === 'done') {
        // Send final assembly results
        const assembledResults = {
          final_transcript: parentJob.final_transcript,
          raw_transcript: parentJob.raw_transcript,
          corrected_transcript: parentJob.corrected_transcript,
          total_chunks: parentJob.total_chunks,
          successful_chunks: parentJob.completed_chunks,
          failed_chunks: parentJob.failed_chunks,
          success_rate: parentJob.success_rate,
          processing_method: parentJob.processing_method,
          total_segments: parentJob.total_segments
        };

        controller.enqueue(new TextEncoder().encode(
          createStreamChunk('final_result', {
            parent_job_id,
            status: 'completed',
            ...assembledResults,
            completion_time: parentJob.completed_at,
            processing_stats: {
              total_processing_time: Date.now() - new Date(parentJob.processing_started_at).getTime(),
              chunks_processed: parentJob.completed_chunks,
              chunks_failed: parentJob.failed_chunks
            }
          })
        ));

        streamLogger.complete('Chunked upload stream completed', {
          parent_job_id,
          filename: parentJob.filename,
          total_chunks: parentJob.total_chunks,
          successful_chunks: parentJob.completed_chunks,
          final_transcript_length: parentJob.final_transcript?.length || 0
        });

        break; // Exit polling loop
      }

      // Check if job failed or was cancelled
      if (parentJob.status === 'failed' || parentJob.status === 'cancelled') {
        controller.enqueue(new TextEncoder().encode(
          createStreamChunk('job_terminated', {
            parent_job_id,
            status: parentJob.status,
            reason: parentJob.error || parentJob.cancellation_reason || 'Unknown',
            partial_results: parentJob.transcripts ? {
              completed_chunks: parentJob.completed_chunks,
              partial_transcript: chunkAssembler.getStreamingAssembly(parentJob.transcripts).partialTranscript
            } : null
          })
        ));

        streamLogger.info('stream', `Chunked upload stream terminated: ${parentJob.status}`, {
          parent_job_id,
          reason: parentJob.error || parentJob.cancellation_reason
        });

        break; // Exit polling loop
      }

      // Send heartbeat to keep connection alive
      controller.enqueue(new TextEncoder().encode('\n'));
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollingInterval));

    } catch (error) {
      streamLogger.error('Error in chunked stream polling', error, { parent_job_id });
      
      controller.enqueue(new TextEncoder().encode(
        createStreamChunk('stream_error', {
          parent_job_id,
          error: error.message,
          recoverable: true
        })
      ));

      // Continue polling despite errors
      await new Promise(resolve => setTimeout(resolve, pollingInterval));
    }
  }

  // Send timeout warning if we reached max duration
  if (Date.now() - startTime >= maxPollingDuration) {
    controller.enqueue(new TextEncoder().encode(
      createStreamChunk('stream_timeout', {
        parent_job_id,
        message: 'Stream timeout reached. Job may still be processing.',
        duration_minutes: maxPollingDuration / 60000,
        current_status: parentJob.status,
        suggestion: 'Use /chunked-upload-status endpoint to check final results'
      })
    ));

    streamLogger.warn('Chunked upload stream timeout', {
      parent_job_id,
      duration_minutes: maxPollingDuration / 60000,
      current_status: parentJob.status
    });
  }
}

/**
 * Create SSE event chunk
 */
function createStreamChunk(type, data) {
  return `data: ${JSON.stringify({ type, timestamp: new Date().toISOString(), ...data })}\n\n`;
}

/**
 * Handle OPTIONS request for CORS
 */
export async function handleChunkedStreamOptions(request) {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
} 