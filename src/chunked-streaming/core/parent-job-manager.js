import { apiLogger, formatBytes } from '../../core/logger.js';

/**
 * Parent Job Manager for Chunked Upload Streaming
 * Handles lifecycle of parent jobs that coordinate multiple chunk sub-jobs
 */

export class ParentJobManager {
  constructor(env) {
    this.env = env;
    this.kv = env.GROQ_JOBS_KV;
  }

  /**
   * Create a new parent job for chunked upload streaming
   */
  async createParentJob({
    filename,
    total_size,
    chunk_size_mb = 10,
    use_llm = false,
    llm_mode = 'per_chunk',
    webhook_url = null
  }) {
    const job_id = crypto.randomUUID();
    const chunk_size_bytes = chunk_size_mb * 1024 * 1024;
    const total_chunks = Math.ceil(total_size / chunk_size_bytes);

    const parentJob = {
      job_id,
      type: 'chunked_upload_streaming',
      status: 'uploading',
      filename,
      total_size,
      chunk_size_bytes,
      chunk_size_mb,
      total_chunks,
      completed_chunks: 0,
      uploaded_chunks: 0,
      failed_chunks: 0,
      sub_jobs: [],
      
      // Results that will be assembled
      final_transcript: '',
      raw_transcript: '',
      corrected_transcript: '',
      transcripts: [], // ordered array of chunk results
      total_segments: 0,
      
      // Processing settings
      use_llm,
      llm_mode,
      webhook_url,
      
      // Progress tracking
      progress: 0,
      upload_progress: 0,
      processing_progress: 0,
      
      // Timing
      created_at: new Date().toISOString(),
      upload_started_at: new Date().toISOString(),
      first_chunk_completed_at: null,
      processing_started_at: null,
      completed_at: null,
      
      // Metadata
      processing_method: 'chunked_upload_streaming',
      success_rate: 0
    };

    await this.kv.put(job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.info('create', 'Created parent job for chunked upload streaming', {
      job_id,
      filename,
      total_size: formatBytes(total_size),
      total_chunks,
      chunk_size: formatBytes(chunk_size_bytes)
    });

    return parentJob;
  }

  /**
   * Get parent job by ID
   */
  async getParentJob(job_id) {
    const jobData = await this.kv.get(job_id);
    if (!jobData) {
      throw new Error(`Parent job ${job_id} not found`);
    }
    return JSON.parse(jobData);
  }

  /**
   * Update parent job data
   */
  async updateParentJob(job_id, updates) {
    const job = await this.getParentJob(job_id);
    const updatedJob = { ...job, ...updates };
    await this.kv.put(job_id, JSON.stringify(updatedJob), { expirationTtl: 86400 });
    return updatedJob;
  }

  /**
   * Add a sub-job to the parent job
   */
  async addSubJob(parent_job_id, sub_job_id, chunk_index) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    // Ensure the sub_jobs array has enough slots
    while (parentJob.sub_jobs.length <= chunk_index) {
      parentJob.sub_jobs.push(null);
    }
    
    // Store the sub_job_id at the correct chunk index position
    parentJob.sub_jobs[chunk_index] = sub_job_id;
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.debug('Added sub-job to parent', {
      parent_job_id,
      sub_job_id,
      chunk_index,
      total_sub_jobs: parentJob.sub_jobs.filter(id => id !== null).length
    });
    
    return parentJob;
  }

  /**
   * Update chunk upload progress
   */
  async updateChunkUploaded(parent_job_id, chunk_index) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.uploaded_chunks = Math.max(parentJob.uploaded_chunks, chunk_index + 1);
    parentJob.upload_progress = Math.round((parentJob.uploaded_chunks / parentJob.total_chunks) * 100);
    
    // Transition to processing if not already
    if (parentJob.status === 'uploading' && parentJob.uploaded_chunks > 0) {
      parentJob.status = 'processing';
      parentJob.processing_started_at = new Date().toISOString();
    }
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    return parentJob;
  }

  /**
   * Update chunk completion progress
   */
  async updateChunkCompleted(parent_job_id, chunk_index, chunk_result) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.completed_chunks++;
    parentJob.processing_progress = Math.round((parentJob.completed_chunks / parentJob.total_chunks) * 100);
    parentJob.progress = Math.round((parentJob.processing_progress + parentJob.upload_progress) / 2);
    
    // Track first completion
    if (!parentJob.first_chunk_completed_at) {
      parentJob.first_chunk_completed_at = new Date().toISOString();
    }
    
    // Store chunk result in ordered array
    while (parentJob.transcripts.length <= chunk_index) {
      parentJob.transcripts.push(null);
    }
    parentJob.transcripts[chunk_index] = chunk_result;
    
    // Update totals
    if (chunk_result.segments) {
      parentJob.total_segments += chunk_result.segments.length;
    }
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.info('chunk', `Chunk ${chunk_index + 1}/${parentJob.total_chunks} completed`, {
      parent_job_id,
      chunk_index,
      progress: parentJob.progress
    });
    
    return parentJob;
  }

  /**
   * Mark a chunk as failed
   */
  async updateChunkFailed(parent_job_id, chunk_index, error) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.failed_chunks++;
    parentJob.success_rate = Math.round(((parentJob.completed_chunks) / (parentJob.completed_chunks + parentJob.failed_chunks)) * 100);
    
    // Store failure in transcripts array
    while (parentJob.transcripts.length <= chunk_index) {
      parentJob.transcripts.push(null);
    }
    parentJob.transcripts[chunk_index] = {
      error: error.message,
      failed: true,
      chunk_index
    };
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.error(`Chunk ${chunk_index + 1} failed`, error, {
      parent_job_id,
      chunk_index,
      failed_chunks: parentJob.failed_chunks
    });
    
    return parentJob;
  }

  /**
   * Check if job is ready for final assembly
   */
  async checkAndStartAssembly(parent_job_id) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    const totalProcessed = parentJob.completed_chunks + parentJob.failed_chunks;
    const isComplete = totalProcessed >= parentJob.total_chunks;
    
    if (isComplete && parentJob.status !== 'assembling' && parentJob.status !== 'done') {
      parentJob.status = 'assembling';
      parentJob.assembly_started_at = new Date().toISOString();
      
      await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
      
      apiLogger.info('assembly', 'Starting final assembly of chunked upload', {
        parent_job_id,
        completed_chunks: parentJob.completed_chunks,
        failed_chunks: parentJob.failed_chunks,
        success_rate: parentJob.success_rate
      });
      
      return true; // Ready for assembly
    }
    
    return false; // Not ready yet
  }

  /**
   * Complete the parent job with final assembled results
   */
  async completeParentJob(parent_job_id, assembledResults) {
    const parentJob = await this.getParentJob(parent_job_id);
    
    parentJob.status = 'done';
    parentJob.completed_at = new Date().toISOString();
    parentJob.progress = 100;
    
    // Store assembled results
    parentJob.final_transcript = assembledResults.final_transcript;
    parentJob.raw_transcript = assembledResults.raw_transcript;
    parentJob.corrected_transcript = assembledResults.corrected_transcript;
    
    // Calculate final success rate
    parentJob.success_rate = Math.round((parentJob.completed_chunks / parentJob.total_chunks) * 100);
    
    await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
    
    apiLogger.complete('Chunked upload streaming job completed', {
      parent_job_id,
      filename: parentJob.filename,
      total_chunks: parentJob.total_chunks,
      completed_chunks: parentJob.completed_chunks,
      success_rate: parentJob.success_rate,
      transcript_length: assembledResults.final_transcript?.length || 0
    });
    
    return parentJob;
  }

  /**
   * Get job summary for listings (without large transcript data)
   */
  getJobSummary(parentJob) {
    return {
      job_id: parentJob.job_id,
      type: parentJob.type,
      status: parentJob.status,
      filename: parentJob.filename,
      total_size: parentJob.total_size,
      total_chunks: parentJob.total_chunks,
      completed_chunks: parentJob.completed_chunks,
      failed_chunks: parentJob.failed_chunks,
      progress: parentJob.progress,
      upload_progress: parentJob.upload_progress,
      processing_progress: parentJob.processing_progress,
      success_rate: parentJob.success_rate,
      use_llm: parentJob.use_llm,
      llm_mode: parentJob.llm_mode,
      processing_method: parentJob.processing_method,
      created_at: parentJob.created_at,
      upload_started_at: parentJob.upload_started_at,
      first_chunk_completed_at: parentJob.first_chunk_completed_at,
      processing_started_at: parentJob.processing_started_at,
      completed_at: parentJob.completed_at,
      total_segments: parentJob.total_segments
    };
  }

  /**
   * Cleanup orphaned chunks and sub-jobs
   */
  async cleanupParentJob(parent_job_id) {
    try {
      const parentJob = await this.getParentJob(parent_job_id);
      
      // Delete sub-jobs from KV
      for (const sub_job_id of parentJob.sub_jobs) {
        try {
          await this.kv.delete(sub_job_id);
        } catch (error) {
          apiLogger.warn('Failed to cleanup sub-job', { sub_job_id, error: error.message });
        }
      }
      
      // Delete parent job
      await this.kv.delete(parent_job_id);
      
      apiLogger.info('cleanup', 'Cleaned up parent job and sub-jobs', {
        parent_job_id,
        sub_jobs_deleted: parentJob.sub_jobs.length
      });
      
    } catch (error) {
      apiLogger.error('Failed to cleanup parent job', error, { parent_job_id });
      throw error;
    }
  }

  /**
   * Cleanup only sub-jobs while keeping parent job with results
   */
  async cleanupSubJobs(parent_job_id) {
    try {
      const parentJob = await this.getParentJob(parent_job_id);
      
      let cleanedCount = 0;
      
      // Delete sub-jobs from KV but keep parent job
      for (const sub_job_id of parentJob.sub_jobs || []) {
        if (sub_job_id) {
          try {
            await this.kv.delete(sub_job_id);
            cleanedCount++;
          } catch (error) {
            apiLogger.warn('Failed to cleanup sub-job', { sub_job_id, error: error.message });
          }
        }
      }
      
      // Clear sub_jobs array in parent job since they're no longer needed
      parentJob.sub_jobs = [];
      await this.kv.put(parent_job_id, JSON.stringify(parentJob), { expirationTtl: 86400 });
      
      apiLogger.info('cleanup', 'Cleaned up sub-jobs only, kept parent job', {
        parent_job_id,
        sub_jobs_deleted: cleanedCount
      });
      
      return cleanedCount;
      
    } catch (error) {
      apiLogger.error('Failed to cleanup sub-jobs', error, { parent_job_id });
      throw error;
    }
  }
} 