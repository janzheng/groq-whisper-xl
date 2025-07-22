import { UploadCoordinator } from '../core/upload-coordinator.js';
import { ParentJobManager } from '../core/parent-job-manager.js';
import { SubJobProcessor } from '../core/sub-job-processor.js';
import { ChunkAssembler } from '../core/chunk-assembly.js';
import { apiLogger, processingLogger } from '../../core/logger.js';
import { withChunkProcessingLimits } from '../../core/rate-limiter.js';

/**
 * Handler for /chunk-upload-complete endpoint
 * Processes chunk upload completion notifications and triggers processing
 */

/**
 * Handle chunk upload completion and trigger processing
 * 
 * curl -X POST http://localhost:8787/chunk-upload-complete \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "parent_job_id": "uuid",
 *     "chunk_index": 0,
 *     "actual_size": 10485760
 *   }'
 */
export async function handleChunkUploadComplete(request, env) {
  try {
    const { parent_job_id, chunk_index, actual_size } = await request.json();

    if (!parent_job_id || chunk_index === undefined) {
      return new Response(JSON.stringify({
        error: 'parent_job_id and chunk_index are required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

         processingLogger.info('upload_complete', `Chunk ${chunk_index} upload completed`, {
      parent_job_id,
      chunk_index,
      actual_size
    });

    // Get parent job details
    const { ParentJobManager } = await import('../core/parent-job-manager.js');
    const parentJobManager = new ParentJobManager(env);
    const parentJob = await parentJobManager.getParentJob(parent_job_id);
    
    if (!parentJob) {
      return new Response(JSON.stringify({
        error: 'Parent job not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update upload progress
    await parentJobManager.updateChunkUploadProgress(parent_job_id, chunk_index);

    // Process this chunk immediately
    const { SubJobProcessor } = await import('../core/sub-job-processor.js');
    const processor = new SubJobProcessor(env);
    
    // Generate sub-job ID for this chunk
    const sub_job_id = `${parent_job_id}_chunk_${chunk_index}`;
    
    try {
      // Process chunk with parent job settings and rate limiting
      const result = await withChunkProcessingLimits(async () => {
        return await processor.processChunk(
          sub_job_id, 
          null, // No stream controller for individual chunk completion
          parentJob.use_llm, 
          parentJob.llm_mode,
          parentJob.model || 'whisper-large-v3' // Use model from parent job
        );
      }, {
        parent_job_id,
        chunk_index,
        operation: 'chunk_upload_complete_processing'
      });

      // Update parent job with chunk result
      await parentJobManager.processCompletedChunk(parent_job_id, result);

             processingLogger.info('processing_complete', `Chunk ${chunk_index} processing completed`, {
        parent_job_id,
        chunk_index,
        model: parentJob.model,
        transcript_length: result.text?.length || 0
      });

      return new Response(JSON.stringify({
        message: 'Chunk upload and processing completed',
        parent_job_id,
        chunk_index,
        actual_size,
        processing_result: {
          text: result.text,
          duration: result.duration,
          model: result.model,
          segments_count: result.segments?.length || 0
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (processingError) {
             processingLogger.error(`Chunk ${chunk_index} processing failed`, processingError, {
        parent_job_id,
        chunk_index,
        model: parentJob.model
      });

      return new Response(JSON.stringify({
        message: 'Chunk uploaded but processing failed',
        parent_job_id,
        chunk_index,
        actual_size,
        processing_error: processingError.message
      }), {
        status: 200, // Upload succeeded, processing failed
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error) {
    processingLogger.error('Chunk upload complete handler failed', error);
    return new Response(JSON.stringify({
      error: 'Failed to handle chunk upload completion',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle batch chunk upload completion for multiple chunks
 * 
 * curl -X POST http://localhost:8787/chunks-upload-complete \
 *   -H "Content-Type: application/json" \
 *   -d '{
 *     "parent_job_id": "uuid",
 *     "completed_chunks": [
 *       {"chunk_index": 0, "actual_size": 10485760},
 *       {"chunk_index": 1, "actual_size": 10485760},
 *       {"chunk_index": 2, "actual_size": 8388608}
 *     ]
 *   }'
 */
export async function handleBatchChunkUploadComplete(request, env) {
  try {
    const body = await request.json();
    const { parent_job_id, completed_chunks } = body;

    if (!parent_job_id) {
      return new Response(JSON.stringify({
        error: 'parent_job_id is required'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!Array.isArray(completed_chunks) || completed_chunks.length === 0) {
      return new Response(JSON.stringify({
        error: 'completed_chunks array is required and must not be empty'
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    apiLogger.info('upload', `Batch chunk upload completion`, {
      parent_job_id,
      chunk_count: completed_chunks.length,
      chunks: completed_chunks.map(c => c.chunk_index)
    });

    const coordinator = new UploadCoordinator(env);
    const results = [];
    const errors = [];

    // Process each chunk completion
    for (const chunk of completed_chunks) {
      try {
        const result = await coordinator.handleChunkUploadComplete(
          parent_job_id,
          chunk.chunk_index,
          chunk.actual_size
        );
        results.push(result);

        // Queue for processing
        if (env.CHUNK_PROCESSING_QUEUE) {
          await env.CHUNK_PROCESSING_QUEUE.send({
            parent_job_id,
            sub_job_id: result.sub_job_id,
            chunk_index: chunk.chunk_index,
            trigger: 'batch_upload_complete'
          });
        }
      } catch (error) {
        errors.push({
          chunk_index: chunk.chunk_index,
          error: error.message
        });
        apiLogger.error(`Failed to process chunk ${chunk.chunk_index} upload completion`, error);
      }
    }

    const response = {
      message: `Batch chunk upload completion processed`,
      parent_job_id,
      successful_chunks: results.length,
      failed_chunks: errors.length,
      total_chunks: completed_chunks.length,
      results,
      errors: errors.length > 0 ? errors : undefined
    };

    const statusCode = errors.length === completed_chunks.length ? 500 : 
                      errors.length > 0 ? 207 : 200; // 207 = Multi-Status

    return new Response(JSON.stringify(response), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    apiLogger.error('Failed to handle batch chunk upload completion', error);
    
    return new Response(JSON.stringify({
      error: 'Failed to process batch chunk upload completion',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Process chunk immediately (for webhook/queue processing)
 * This is called by the queue worker when a chunk upload is completed
 */
export async function processChunkUpload(parent_job_id, sub_job_id, chunk_index, env) {
  const parentJobManager = new ParentJobManager(env);
  const subJobProcessor = new SubJobProcessor(env);
  const chunkAssembler = new ChunkAssembler(env);

  try {
    apiLogger.info('processing', `Starting chunk ${chunk_index} processing`, {
      parent_job_id,
      sub_job_id,
      chunk_index
    });

    // Get parent job for processing settings
    const parentJob = await parentJobManager.getParentJob(parent_job_id);
    
    // Process the chunk (this includes transcription and optional LLM correction) with rate limiting
    const chunkResult = await withChunkProcessingLimits(async () => {
      return await subJobProcessor.processChunk(
        sub_job_id,
        null, // No stream controller for queue processing
        parentJob.use_llm,
        parentJob.llm_mode
      );
    }, {
      parent_job_id,
      sub_job_id,
      chunk_index,
      operation: 'queue_chunk_processing'
    });

    // Update parent job with chunk completion
    await parentJobManager.updateChunkCompleted(parent_job_id, chunk_index, chunkResult);

    // Check if all chunks are complete for final assembly
    const readyForAssembly = await parentJobManager.checkAndStartAssembly(parent_job_id);
    
    if (readyForAssembly) {
      apiLogger.info('assembly', 'Starting final assembly for chunked upload', {
        parent_job_id,
        completed_chunks: parentJob.completed_chunks + 1
      });

      // Get updated parent job with all chunk results
      const updatedParentJob = await parentJobManager.getParentJob(parent_job_id);
      
      // Assemble final results
      const assembledResults = await chunkAssembler.assembleChunks(updatedParentJob);
      
      // Complete the parent job
      await parentJobManager.completeParentJob(parent_job_id, assembledResults);

      // Cleanup sub-jobs after successful completion (they're no longer needed)
      try {
        const cleanedCount = await parentJobManager.cleanupSubJobs(parent_job_id);
        apiLogger.info('cleanup', 'Cleaned up sub-jobs after parent job completion', {
          parent_job_id,
          sub_jobs_cleaned: cleanedCount
        });
      } catch (cleanupError) {
        apiLogger.error('Failed to cleanup sub-jobs after completion', cleanupError, { parent_job_id });
        // Don't throw - job completed successfully, cleanup is just housekeeping
      }

      // Send webhook if configured
      if (updatedParentJob.webhook_url) {
        await sendWebhook(updatedParentJob.webhook_url, parent_job_id, assembledResults);
      }

      apiLogger.complete('Chunked upload processing completed', {
        parent_job_id,
        filename: updatedParentJob.filename,
        total_chunks: updatedParentJob.total_chunks,
        successful_chunks: assembledResults.successful_chunks,
        final_transcript_length: assembledResults.final_transcript?.length || 0
      });
    }

    return {
      status: 'chunk_processed',
      parent_job_id,
      sub_job_id,
      chunk_index,
      chunk_result: chunkResult,
      assembly_triggered: readyForAssembly
    };

  } catch (error) {
    // Mark chunk as failed
    await parentJobManager.updateChunkFailed(parent_job_id, chunk_index, error);
    
    apiLogger.error(`Chunk ${chunk_index} processing failed`, error, {
      parent_job_id,
      sub_job_id,
      chunk_index
    });

    // Check if we should still attempt assembly (with some chunks failed)
    const readyForAssembly = await parentJobManager.checkAndStartAssembly(parent_job_id);
    
    if (readyForAssembly) {
      try {
        const updatedParentJob = await parentJobManager.getParentJob(parent_job_id);
        const assembledResults = await chunkAssembler.assembleChunks(updatedParentJob);
        await parentJobManager.completeParentJob(parent_job_id, assembledResults);
        
        apiLogger.info('assembly', 'Completed assembly despite some failed chunks', {
          parent_job_id,
          successful_chunks: assembledResults.successful_chunks,
          failed_chunks: assembledResults.failed_chunks
        });
      } catch (assemblyError) {
        apiLogger.error('Final assembly failed', assemblyError, { parent_job_id });
      }
    }

    throw error;
  }
}

/**
 * Send webhook notification
 */
async function sendWebhook(webhookUrl, parentJobId, assembledResults) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'chunked_upload_complete',
        parent_job_id: parentJobId,
        status: 'completed',
        final_transcript: assembledResults.final_transcript,
        raw_transcript: assembledResults.raw_transcript,
        corrected_transcript: assembledResults.corrected_transcript,
        total_chunks: assembledResults.total_chunks,
        successful_chunks: assembledResults.successful_chunks,
        failed_chunks: assembledResults.failed_chunks,
        success_rate: assembledResults.success_rate,
        processing_method: 'chunked_upload_streaming',
        completed_at: new Date().toISOString()
      })
    });
  } catch (error) {
    apiLogger.error('Webhook notification failed', error, { 
      webhook_url: webhookUrl,
      parent_job_id: parentJobId 
    });
  }
} 