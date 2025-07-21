import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { transcribeChunk, applyPerChunkLLMCorrection } from '../../core/streaming.js';
import { processingLogger, formatBytes } from '../../core/logger.js';

/**
 * Sub-job Processor for individual chunks in chunked upload streaming
 * Handles the processing of individual audio chunks with streaming feedback
 */

export class SubJobProcessor {
  constructor(env) {
    this.env = env;
    this.kv = env.GROQ_JOBS_KV;
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
   * Create a sub-job for a specific chunk
   */
  async createSubJob({
    parent_job_id,
    chunk_index,
    chunk_range,
    filename,
    size
  }) {
    const sub_job_id = crypto.randomUUID();
    const key = `uploads/${parent_job_id}/chunk.${chunk_index}.${this.getExtension(filename)}`;

    const subJob = {
      job_id: sub_job_id,
      parent_job_id,
      type: 'chunk_sub_job',
      chunk_index,
      chunk_range, // [start_byte, end_byte]
      
      status: 'pending', // pending -> uploaded -> processing -> done/failed
      filename: `${filename}.chunk.${chunk_index}`,
      original_filename: filename,
      size,
      key,
      
      // Results
      final_transcript: '',
      raw_transcript: '',
      corrected_transcript: '',
      transcripts: [],
      segments: [],
      
      // Timing
      created_at: new Date().toISOString(),
      uploaded_at: null,
      processing_started_at: null,
      completed_at: null,
      failed_at: null,
      
      // Error tracking
      error: null,
      retry_count: 0,
      max_retries: 3
    };

    await this.kv.put(sub_job_id, JSON.stringify(subJob), { expirationTtl: 86400 });
    
    processingLogger.info('create', `Created sub-job for chunk ${chunk_index}`, {
      sub_job_id,
      parent_job_id,
      chunk_index,
      size: formatBytes(size)
    });

    return subJob;
  }

  /**
   * Get sub-job by ID
   */
  async getSubJob(sub_job_id) {
    const jobData = await this.kv.get(sub_job_id);
    if (!jobData) {
      throw new Error(`Sub-job ${sub_job_id} not found`);
    }
    return JSON.parse(jobData);
  }

  /**
   * Update sub-job status and data
   */
  async updateSubJob(sub_job_id, updates) {
    const subJob = await this.getSubJob(sub_job_id);
    const updatedSubJob = { ...subJob, ...updates };
    await this.kv.put(sub_job_id, JSON.stringify(updatedSubJob), { expirationTtl: 86400 });
    return updatedSubJob;
  }

  /**
   * Mark sub-job as uploaded and ready for processing
   */
  async markChunkUploaded(sub_job_id, actual_size) {
    const subJob = await this.updateSubJob(sub_job_id, {
      status: 'uploaded',
      actual_size,
      uploaded_at: new Date().toISOString()
    });

    processingLogger.info('upload', `Chunk ${subJob.chunk_index} uploaded`, {
      sub_job_id,
      parent_job_id: subJob.parent_job_id,
      chunk_index: subJob.chunk_index,
      actual_size: formatBytes(actual_size)
    });

    return subJob;
  }

  /**
   * Process a chunk with streaming support
   */
  async processChunk(sub_job_id, streamController = null, use_llm = false, llm_mode = 'per_chunk') {
    const subJob = await this.getSubJob(sub_job_id);
    
    try {
      // Store processing start time locally for accurate calculation
      const processingStartTime = Date.now();
      
      // Update status to processing
      await this.updateSubJob(sub_job_id, {
        status: 'processing',
        processing_started_at: new Date().toISOString()
      });

      if (streamController) {
        this.sendStreamEvent(streamController, 'chunk_processing_start', {
          chunk_index: subJob.chunk_index,
          parent_job_id: subJob.parent_job_id,
          filename: subJob.original_filename
        });
      }

      // Get chunk data from R2
      const bucketName = this.env.R2_BUCKET_NAME || 
        (this.env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
      
      const getObjectCmd = new GetObjectCommand({ 
        Bucket: bucketName, 
        Key: subJob.key 
      });
      const response = await this.s3Client.send(getObjectCmd);
      
      // Convert stream to buffer
      const chunks = [];
      const reader = response.Body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const audioBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audioBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      processingLogger.transcribe(`Starting transcription for chunk ${subJob.chunk_index}`, {
        sub_job_id,
        chunk_index: subJob.chunk_index,
        size: formatBytes(totalLength)
      });

      // Transcribe the chunk
      const ext = this.getExtension(subJob.original_filename);
      const transcript = await transcribeChunk(audioBuffer, ext, this.env.GROQ_API_KEY);
      
      let finalText = transcript.text || '';
      let correctedText = finalText;

      // Apply LLM correction if requested
      if (use_llm && llm_mode === 'per_chunk' && finalText) {
        try {
          correctedText = await applyPerChunkLLMCorrection(finalText, this.env.GROQ_API_KEY);
          
          if (streamController) {
            this.sendStreamEvent(streamController, 'chunk_delta', {
              chunk_index: subJob.chunk_index,
              parent_job_id: subJob.parent_job_id,
              raw_text: finalText,
              corrected_text: correctedText,
              segments: transcript.segments || [],
              llm_applied: true
            });
          }
        } catch (llmError) {
          processingLogger.warn(`LLM correction failed for chunk ${subJob.chunk_index}`, llmError);
          correctedText = finalText; // fallback to raw text
          
          if (streamController) {
            this.sendStreamEvent(streamController, 'chunk_delta', {
              chunk_index: subJob.chunk_index,
              parent_job_id: subJob.parent_job_id,
              raw_text: finalText,
              corrected_text: finalText,
              segments: transcript.segments || [],
              llm_applied: false,
              llm_error: llmError.message
            });
          }
        }
      } else {
        // No LLM correction
        if (streamController) {
          this.sendStreamEvent(streamController, 'chunk_delta', {
            chunk_index: subJob.chunk_index,
            parent_job_id: subJob.parent_job_id,
            text: finalText,
            raw_text: finalText,
            segments: transcript.segments || [],
            llm_applied: false
          });
        }
      }

      // Create result object
      const chunkResult = {
        text: use_llm && llm_mode === 'per_chunk' ? correctedText : finalText,
        raw_text: finalText,
        corrected_text: use_llm && llm_mode === 'per_chunk' ? correctedText : null,
        segments: transcript.segments || [],
        start: subJob.chunk_range[0],
        end: subJob.chunk_range[1],
        duration: totalLength,
        chunk_index: subJob.chunk_index,
        processing_time: Date.now() - processingStartTime, // Use local timestamp
        llm_applied: use_llm && llm_mode === 'per_chunk'
      };

      // Update sub-job with results
      await this.updateSubJob(sub_job_id, {
        status: 'done',
        completed_at: new Date().toISOString(),
        final_transcript: chunkResult.text,
        raw_transcript: finalText,
        corrected_transcript: correctedText,
        transcripts: [chunkResult],
        segments: transcript.segments || []
      });

      if (streamController) {
        this.sendStreamEvent(streamController, 'chunk_complete', {
          chunk_index: subJob.chunk_index,
          parent_job_id: subJob.parent_job_id,
          transcript: chunkResult.text,
          processing_time: chunkResult.processing_time
        });
      }

      processingLogger.complete(`Chunk ${subJob.chunk_index} processing completed`, {
        sub_job_id,
        chunk_index: subJob.chunk_index,
        transcript_length: chunkResult.text?.length || 0,
        processing_time: chunkResult.processing_time
      });

      return chunkResult;

    } catch (error) {
      // Handle processing failure
      await this.updateSubJob(sub_job_id, {
        status: 'failed',
        failed_at: new Date().toISOString(),
        error: error.message,
        retry_count: subJob.retry_count + 1
      });

      if (streamController) {
        this.sendStreamEvent(streamController, 'chunk_error', {
          chunk_index: subJob.chunk_index,
          parent_job_id: subJob.parent_job_id,
          error: error.message
        });
      }

      processingLogger.error(`Chunk ${subJob.chunk_index} processing failed`, error, {
        sub_job_id,
        chunk_index: subJob.chunk_index,
        retry_count: subJob.retry_count
      });

      throw error;
    }
  }

  /**
   * Retry failed chunk processing
   */
  async retryChunkProcessing(sub_job_id, streamController = null, use_llm = false, llm_mode = 'per_chunk') {
    const subJob = await this.getSubJob(sub_job_id);
    
    if (subJob.retry_count >= subJob.max_retries) {
      throw new Error(`Chunk ${subJob.chunk_index} has exceeded maximum retries (${subJob.max_retries})`);
    }

    processingLogger.info('retry', `Retrying chunk ${subJob.chunk_index} processing`, {
      sub_job_id,
      chunk_index: subJob.chunk_index,
      retry_count: subJob.retry_count + 1,
      max_retries: subJob.max_retries
    });

    // Add delay before retry
    await new Promise(resolve => setTimeout(resolve, Math.pow(2, subJob.retry_count) * 1000));

    return this.processChunk(sub_job_id, streamController, use_llm, llm_mode);
  }

  /**
   * Get all sub-jobs for a parent job
   */
  async getSubJobsForParent(parent_job_id) {
    // This is a simplified version - in production you might want to optimize this
    // by storing sub-job IDs in the parent job or using a more efficient query method
    const listResult = await this.kv.list({ limit: 1000 });
    const subJobs = [];
    
    for (const key of listResult.keys) {
      try {
        const jobData = await this.kv.get(key.name);
        if (jobData) {
          const job = JSON.parse(jobData);
          if (job.type === 'chunk_sub_job' && job.parent_job_id === parent_job_id) {
            subJobs.push(job);
          }
        }
      } catch (error) {
        // Skip invalid entries
        continue;
      }
    }
    
    // Sort by chunk index
    return subJobs.sort((a, b) => a.chunk_index - b.chunk_index);
  }

  /**
   * Cleanup sub-job and its associated files
   */
  async cleanupSubJob(sub_job_id) {
    try {
      const subJob = await this.getSubJob(sub_job_id);
      
      // Delete chunk file from R2 if it exists
      if (subJob.key) {
        try {
          const bucketName = this.env.R2_BUCKET_NAME || 
            (this.env.ENVIRONMENT === 'development' ? 'groq-whisper-audio-preview' : 'groq-whisper-audio');
          
          const deleteCmd = new DeleteObjectCommand({ 
            Bucket: bucketName, 
            Key: subJob.key 
          });
          await this.s3Client.send(deleteCmd);
          
          processingLogger.info('cleanup', `Deleted chunk file from R2`, {
            sub_job_id,
            key: subJob.key
          });
        } catch (error) {
          processingLogger.warn('Failed to delete chunk file from R2', {
            sub_job_id,
            key: subJob.key,
            error: error.message
          });
        }
      }
      
      // Delete sub-job from KV
      await this.kv.delete(sub_job_id);
      
      processingLogger.info('cleanup', `Cleaned up sub-job`, {
        sub_job_id,
        chunk_index: subJob.chunk_index
      });
      
    } catch (error) {
      processingLogger.error('Failed to cleanup sub-job', error, { sub_job_id });
      throw error;
    }
  }

  /**
   * Helper methods
   */
  getExtension(filename) {
    return filename.split('.').pop() || 'mp3';
  }

  sendStreamEvent(controller, type, data) {
    if (controller) {
      const eventData = `data: ${JSON.stringify({ type, ...data })}\n\n`;
      controller.enqueue(new TextEncoder().encode(eventData));
    }
  }
} 