import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { apiLogger, formatBytes } from '../../core/logger.js';
import { ParentJobManager } from './parent-job-manager.js';
import { SubJobProcessor } from './sub-job-processor.js';

/**
 * Upload Coordinator for Chunked Upload Streaming
 * Handles multi-part upload coordination and presigned URL generation
 */

export class UploadCoordinator {
  constructor(env) {
    this.env = env;
    this.parentJobManager = new ParentJobManager(env);
    this.subJobProcessor = new SubJobProcessor(env);
    this.s3Client = this.createS3Client();
  }

  createS3Client() {
    return new S3Client({
      region: 'auto',
      endpoint: `https://${this.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { 
        accessKeyId: this.env.R2_ACCESS_KEY_ID, 
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY 
      },
    });
  }

  /**
   * Initialize chunked upload streaming - creates parent job and generates upload URLs
   */
  async initializeChunkedUpload({
    filename,
    total_size,
    chunk_size_mb = 5,
    use_llm = false,
    llm_mode = 'per_chunk',
    webhook_url = null,
    max_concurrent_uploads = 3
  }) {
    try {
      // Validate input parameters
      this.validateUploadParams({ filename, total_size, chunk_size_mb });

      // Create parent job
      const parentJob = await this.parentJobManager.createParentJob({
        filename,
        total_size,
        chunk_size_mb,
        use_llm,
        llm_mode,
        webhook_url
      });

      // Calculate chunks and generate upload URLs
      const chunkPlan = this.calculateChunkPlan(total_size, chunk_size_mb * 1024 * 1024);
      const uploadUrls = await this.generateUploadUrls(parentJob.job_id, filename, chunkPlan);

      // Create sub-jobs for each chunk
      const subJobs = await this.createSubJobs(parentJob.job_id, filename, chunkPlan);

      apiLogger.info('init', 'Initialized chunked upload streaming', {
        parent_job_id: parentJob.job_id,
        filename,
        total_size: formatBytes(total_size),
        total_chunks: chunkPlan.length,
        chunk_size: formatBytes(chunk_size_mb * 1024 * 1024),
        use_llm,
        llm_mode
      });

      return {
        parent_job_id: parentJob.job_id,
        stream_url: `/chunked-stream/${parentJob.job_id}`,
        upload_urls: uploadUrls,
        sub_jobs: subJobs.map(job => job.job_id),
        chunk_info: {
          total_chunks: chunkPlan.length,
          chunk_size_bytes: chunk_size_mb * 1024 * 1024,
          total_size,
          max_concurrent_uploads,
          estimated_processing_time: this.estimateProcessingTime(chunkPlan.length, use_llm)
        },
        processing_options: {
          use_llm,
          llm_mode,
          webhook_url
        }
      };

    } catch (error) {
      apiLogger.error('Failed to initialize chunked upload', error, {
        filename,
        total_size: formatBytes(total_size)
      });
      throw error;
    }
  }

  /**
   * Validate upload parameters
   */
  validateUploadParams({ filename, total_size, chunk_size_mb }) {
    if (!filename || typeof filename !== 'string') {
      throw new Error('Valid filename is required');
    }

    if (!total_size || total_size <= 0) {
      throw new Error('Valid total_size is required');
    }

    if (chunk_size_mb < 1 || chunk_size_mb > 100) {
      throw new Error('chunk_size_mb must be between 1 and 100 MB');
    }

    // Check if file is large enough to warrant chunked upload
    const MIN_SIZE_FOR_CHUNKING = 5 * 1024 * 1024; // 5MB
    if (total_size < MIN_SIZE_FOR_CHUNKING) {
      throw new Error(`File too small for chunked upload. Use regular streaming for files under ${formatBytes(MIN_SIZE_FOR_CHUNKING)}`);
    }

    // Check maximum file size
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
    if (total_size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum size is ${formatBytes(MAX_FILE_SIZE)}`);
    }
  }

  /**
   * Calculate chunk plan - determine byte ranges for each chunk
   */
  calculateChunkPlan(total_size, chunk_size_bytes) {
    const chunks = [];
    let start = 0;

    while (start < total_size) {
      const end = Math.min(start + chunk_size_bytes, total_size);
      chunks.push({
        chunk_index: chunks.length,
        start,
        end,
        size: end - start
      });
      start = end;
    }

    return chunks;
  }

  /**
   * Generate upload URLs for all chunks - using Worker endpoint to avoid CORS
   */
  async generateUploadUrls(parent_job_id, filename, chunkPlan) {
    const uploadUrls = [];

    for (const chunk of chunkPlan) {
      // Instead of generating presigned R2 URLs, use Worker endpoint
      const workerUploadUrl = `/chunk-upload`;
      
      uploadUrls.push({
        chunk_index: chunk.chunk_index,
        upload_url: workerUploadUrl,
        parent_job_id: parent_job_id, // Include for the Worker endpoint
        expected_size: chunk.size,
        byte_range: [chunk.start, chunk.end - 1] // Inclusive range
      });
    }

    return uploadUrls;
  }

  /**
   * Create sub-jobs for all chunks
   */
  async createSubJobs(parent_job_id, filename, chunkPlan) {
    const subJobs = [];

    for (const chunk of chunkPlan) {
      const subJob = await this.subJobProcessor.createSubJob({
        parent_job_id,
        chunk_index: chunk.chunk_index,
        chunk_range: [chunk.start, chunk.end],
        filename,
        size: chunk.size
      });

      // Link sub-job to parent
      await this.parentJobManager.addSubJob(parent_job_id, subJob.job_id, chunk.chunk_index);
      
      subJobs.push(subJob);
    }

    return subJobs;
  }

  /**
   * Handle chunk upload completion - trigger immediate processing
   */
  async handleChunkUploadComplete(parent_job_id, chunk_index, actual_size) {
    try {
      // Update parent job upload progress
      await this.parentJobManager.updateChunkUploaded(parent_job_id, chunk_index);

      // Get sub-job for this chunk
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      const sub_job_id = parentJob.sub_jobs[chunk_index]; // Should match chunk index

      if (!sub_job_id) {
        throw new Error(`Sub-job not found for chunk ${chunk_index}. Available sub-jobs: ${parentJob.sub_jobs.length}, chunk_index: ${chunk_index}`);
      }
      
      // Additional validation: verify the sub-job actually exists
      try {
        await this.subJobProcessor.getSubJob(sub_job_id);
      } catch (error) {
        throw new Error(`Sub-job ${sub_job_id} for chunk ${chunk_index} not found in KV storage: ${error.message}`);
      }

      // Mark sub-job as uploaded
      await this.subJobProcessor.markChunkUploaded(sub_job_id, actual_size);

      // Trigger immediate processing via queue or directly
      let processingQueued = false;
      let processingMethod = 'direct';
      
      if (this.env.CHUNK_PROCESSING_QUEUE) {
        try {
          await this.env.CHUNK_PROCESSING_QUEUE.send({ 
            parent_job_id, 
            sub_job_id,
            chunk_index,
            trigger: 'upload_complete'
          });
          processingQueued = true;
          processingMethod = 'queue';
        } catch (queueError) {
          apiLogger.warn('Queue not available, falling back to direct processing', queueError);
        }
      }
      
      // If queue failed or not available, process directly
      if (!processingQueued) {
        try {
          // Import the processor function for direct processing
          const { processChunkUpload } = await import('../handlers/chunk-upload-complete-handler.js');
          
          // Process directly and await completion to ensure proper error handling
          await processChunkUpload(parent_job_id, sub_job_id, chunk_index, this.env);
          
          processingMethod = 'direct';
          apiLogger.info('upload', `Chunk ${chunk_index} upload completed, processing directly`, {
            parent_job_id,
            sub_job_id,
            chunk_index,
            actual_size: formatBytes(actual_size)
          });
        } catch (error) {
          apiLogger.error('Failed to start direct processing', error);
          throw new Error(`Failed to process chunk ${chunk_index}: ${error.message}`);
        }
      } else {
        apiLogger.info('upload', `Chunk ${chunk_index} upload completed, processing queued`, {
          parent_job_id,
          sub_job_id,
          chunk_index,
          actual_size: formatBytes(actual_size)
        });
      }

      return {
        status: 'upload_complete',
        processing_queued: processingQueued,
        processing_method: processingMethod,
        parent_job_id,
        sub_job_id,
        chunk_index
      };

    } catch (error) {
      apiLogger.error(`Failed to handle chunk ${chunk_index} upload completion`, error, {
        parent_job_id,
        chunk_index
      });
      throw error;
    }
  }

  /**
   * Get upload status for a parent job
   */
  async getUploadStatus(parent_job_id) {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      
      // Get detailed status for each chunk
      const chunkStatuses = [];
      for (let i = 0; i < parentJob.total_chunks; i++) {
        const sub_job_id = parentJob.sub_jobs[i];
        if (sub_job_id) {
          try {
            const subJob = await this.subJobProcessor.getSubJob(sub_job_id);
            chunkStatuses.push({
              chunk_index: i,
              status: subJob.status,
              uploaded_at: subJob.uploaded_at,
              processing_started_at: subJob.processing_started_at,
              completed_at: subJob.completed_at,
              error: subJob.error
            });
          } catch (error) {
            chunkStatuses.push({
              chunk_index: i,
              status: 'error',
              error: 'Sub-job not found'
            });
          }
        } else {
          chunkStatuses.push({
            chunk_index: i,
            status: 'pending',
            uploaded_at: null,
            processing_started_at: null,
            completed_at: null
          });
        }
      }

      return {
        parent_job_id,
        overall_status: parentJob.status,
        progress: parentJob.progress,
        upload_progress: parentJob.upload_progress,
        processing_progress: parentJob.processing_progress,
        total_chunks: parentJob.total_chunks,
        uploaded_chunks: parentJob.uploaded_chunks,
        completed_chunks: parentJob.completed_chunks,
        failed_chunks: parentJob.failed_chunks,
        chunk_statuses: chunkStatuses,
        created_at: parentJob.created_at,
        processing_started_at: parentJob.processing_started_at,
        first_chunk_completed_at: parentJob.first_chunk_completed_at
      };

    } catch (error) {
      apiLogger.error('Failed to get upload status', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Cancel/cleanup a chunked upload
   */
  async cancelChunkedUpload(parent_job_id, reason = 'user_cancelled') {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);

      // Cleanup all sub-jobs
      for (const sub_job_id of parentJob.sub_jobs) {
        try {
          await this.subJobProcessor.cleanupSubJob(sub_job_id);
        } catch (error) {
          apiLogger.warn('Failed to cleanup sub-job during cancellation', {
            sub_job_id,
            error: error.message
          });
        }
      }

      // Update parent job status
      await this.parentJobManager.updateParentJob(parent_job_id, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason
      });

      apiLogger.info('cancel', 'Chunked upload cancelled', {
        parent_job_id,
        reason,
        cleaned_sub_jobs: parentJob.sub_jobs.length
      });

      return {
        status: 'cancelled',
        parent_job_id,
        reason,
        cleaned_sub_jobs: parentJob.sub_jobs.length
      };

    } catch (error) {
      apiLogger.error('Failed to cancel chunked upload', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Estimate processing time based on chunk count and settings
   */
  estimateProcessingTime(total_chunks, use_llm) {
    // Base time per chunk (in seconds)
    const baseTimePerChunk = 15; // 15 seconds per chunk
    const llmOverhead = use_llm ? 5 : 0; // Additional 5 seconds if LLM is used
    
    const totalTime = total_chunks * (baseTimePerChunk + llmOverhead);
    
    // Format as human-readable string
    if (totalTime < 60) {
      return `${totalTime} seconds`;
    } else if (totalTime < 3600) {
      const minutes = Math.ceil(totalTime / 60);
      return `${minutes} minutes`;
    } else {
      const hours = Math.floor(totalTime / 3600);
      const minutes = Math.ceil((totalTime % 3600) / 60);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Get file extension from filename
   */
  getExtension(filename) {
    return filename.split('.').pop() || 'mp3';
  }

  /**
   * Validate chunk upload before processing
   */
  async validateChunkUpload(parent_job_id, chunk_index, uploaded_size) {
    const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
    const expectedSize = Math.ceil(parentJob.total_size / parentJob.total_chunks);
    
    // Allow some variance in file size (compression, format differences)
    const sizeVariance = 0.1; // 10% variance allowed
    const minSize = expectedSize * (1 - sizeVariance);
    const maxSize = expectedSize * (1 + sizeVariance);

    if (uploaded_size < minSize || uploaded_size > maxSize) {
      apiLogger.warn('Chunk size validation warning', {
        parent_job_id,
        chunk_index,
        expected_size: expectedSize,
        uploaded_size,
        variance_percent: Math.abs(uploaded_size - expectedSize) / expectedSize * 100
      });
    }

    return {
      valid: true, // We'll be lenient for now
      expected_size: expectedSize,
      uploaded_size,
      size_variance: Math.abs(uploaded_size - expectedSize) / expectedSize
    };
  }

  /**
   * Retry failed chunk uploads
   */
  async retryChunkUpload(parent_job_id, chunk_index) {
    try {
      const parentJob = await this.parentJobManager.getParentJob(parent_job_id);
      const sub_job_id = parentJob.sub_jobs[chunk_index];

      if (!sub_job_id) {
        throw new Error(`Sub-job not found for chunk ${chunk_index}`);
      }

      // Reset sub-job status
      await this.subJobProcessor.updateSubJob(sub_job_id, {
        status: 'pending',
        error: null,
        retry_count: 0,
        uploaded_at: null,
        processing_started_at: null,
        completed_at: null,
        failed_at: null
      });

      // Generate new upload URL
      const filename = parentJob.filename;
      const chunkPlan = this.calculateChunkPlan(parentJob.total_size, parentJob.chunk_size_bytes);
      const chunk = chunkPlan[chunk_index];
      
      const newUploadUrls = await this.generateUploadUrls(parent_job_id, filename, [chunk]);

      apiLogger.info('retry', `Generated retry upload URL for chunk ${chunk_index}`, {
        parent_job_id,
        sub_job_id,
        chunk_index
      });

      return {
        chunk_index,
        upload_url: newUploadUrls[0].upload_url,
        sub_job_id,
        retry: true
      };

    } catch (error) {
      apiLogger.error(`Failed to retry chunk ${chunk_index} upload`, error, {
        parent_job_id,
        chunk_index
      });
      throw error;
    }
  }
} 