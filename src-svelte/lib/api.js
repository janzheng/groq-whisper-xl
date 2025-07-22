import { jobs, API_BASE, chunkedProgress, chunkedUploadedChunks, updateChunkSlot } from './stores.js';
import { webLogger } from './logger.js';
import { get } from 'svelte/store';

/**
 * Determine if a local job should be kept when it doesn't exist on the server
 */
function isRecentLocalJob(job) {
  const now = Date.now();
  const jobAge = now - new Date(job.created_at).getTime();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  
  // Always keep currently active streaming jobs
  if (job.processing_method === 'streaming' && (job.status === 'processing' || job.status === 'uploading')) {
    return true;
  }
  
  // Always keep currently active chunked streaming jobs  
  if (job.processing_method === 'chunked_upload_streaming' && (job.status === 'processing' || job.status === 'uploading')) {
    return true;
  }
  
  // Keep recent streaming jobs (might not be saved to server yet)
  if (job.processing_method === 'streaming' && jobAge < maxAge) {
    return true;
  }
  
  // Remove everything else:
  // - Old completed jobs
  // - Sub-jobs from completed chunked uploads  
  // - Failed jobs that have been cleaned up
  // - Direct upload jobs (these should always exist on server)
  return false;
}

export async function fetchJobs() {
  try {
    console.log('=== FETCH JOBS CALLED ===');
    const currentJobs = get(jobs);
    console.log('Jobs before fetch:', currentJobs.length, currentJobs.map(j => ({ id: j.job_id.slice(0, 8) + '...', method: j.processing_method })));
    
    const response = await fetch(API_BASE + '/jobs');
    if (response.ok) {
      const data = await response.json();
      const serverJobs = data.jobs || [];
      
      console.log('Server returned jobs:', serverJobs.length, serverJobs.map(j => ({ id: j.job_id.slice(0, 8) + '...', method: j.processing_method || 'direct' })));
      
      // Create a comprehensive map of ALL existing job IDs to avoid duplicates
      const allExistingJobIds = new Set(currentJobs.map(job => job.job_id));
      
      // Filter out server jobs that already exist locally to get only NEW server jobs
      const newServerJobs = serverJobs.filter(job => !allExistingJobIds.has(job.job_id));
      
      console.log('New server jobs to add:', newServerJobs.length, newServerJobs.map(j => ({ id: j.job_id.slice(0, 8) + '...', method: j.processing_method || 'direct' })));
      
      // For existing jobs, merge server data with local data, preferring server data for most fields
      // but preserving any local-only properties
      const updatedJobs = [];
      
      for (const localJob of currentJobs) {
        const serverJob = serverJobs.find(sj => sj.job_id === localJob.job_id);
        if (serverJob) {
          // Job exists on server, merge server data with local data
          updatedJobs.push({
            ...localJob,  // Start with local job
            ...serverJob, // Override with server data
            // Preserve any streaming-specific local properties that server might not have
            ...(localJob.processing_method === 'streaming' ? {
              raw_transcript: localJob.raw_transcript || serverJob.raw_transcript,
              corrected_transcript: localJob.corrected_transcript || serverJob.corrected_transcript,
              final_transcript: localJob.final_transcript || serverJob.final_transcript,
              transcripts: localJob.transcripts || serverJob.transcripts || []
            } : {})
          });
        } else {
          // Job doesn't exist on server - decide whether to keep it
          const shouldKeepLocalJob = isRecentLocalJob(localJob);
          
          if (shouldKeepLocalJob) {
            // Keep recent streaming jobs or active chunked uploads that might not be saved yet
            updatedJobs.push(localJob);
          } else {
            // Remove old jobs that no longer exist on server (e.g., cleaned up sub-jobs)
            console.log('Removing local job that no longer exists on server:', localJob.job_id.slice(0, 8) + '...', localJob.processing_method);
          }
        }
      }
      
      // Add any completely new server jobs
      const mergedJobs = [...updatedJobs, ...newServerJobs];
      
      // Remove any actual duplicates that might slip through (final safety net)
      const uniqueJobs = [];
      const seenIds = new Set();
      for (const job of mergedJobs) {
        if (!seenIds.has(job.job_id)) {
          seenIds.add(job.job_id);
          uniqueJobs.push(job);
        }
      }
      
      jobs.set(uniqueJobs);
      
      console.log('Jobs after fetch and deduplication:', uniqueJobs.length, uniqueJobs.map(j => ({ id: j.job_id.slice(0, 8) + '...', method: j.processing_method })));
      
      webLogger.info('api', 'Fetched jobs', { 
        server_jobs: serverJobs.length, 
        new_server_jobs: newServerJobs.length,
        local_jobs_preserved: currentJobs.length,
        total: uniqueJobs.length,
        duplicates_removed: mergedJobs.length - uniqueJobs.length
      });
    }
  } catch (error) {
    console.error('Fetch jobs error:', error);
    webLogger.error('Failed to fetch jobs', error);
  }
}

export async function uploadFile(file, useLLM = false, webhookUrl = null, model = 'whisper-large-v3', chunkSizeMB = 10, debugSaveChunks = false) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('use_llm', useLLM);
  formData.append('model', model);
  formData.append('chunk_size_mb', chunkSizeMB.toString());
  formData.append('debug_save_chunks', debugSaveChunks.toString());
  
  if (webhookUrl) {
    formData.append('webhook_url', webhookUrl);
  }
  
  const response = await fetch(API_BASE + '/upload', {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }
  
  const result = await response.json();
  await fetchJobs(); // Refresh the jobs list immediately
  
  // For direct uploads, set up more frequent polling to catch completion faster
  if (result.job_id) {
    // Check for completion more frequently for this specific job
    const jobId = result.job_id;
    console.log('Setting up completion monitoring for direct upload job:', jobId);
    
    const completionChecker = setInterval(async () => {
      try {
        console.log('Checking direct upload job completion:', jobId);
        await fetchJobs();
        
        // Check if this specific job is now complete
        const currentJobs = get(jobs);
        const targetJob = currentJobs.find(job => job.job_id === jobId);
        
        if (targetJob && targetJob.status === 'done') {
          console.log('Direct upload job completed:', jobId);
          clearInterval(completionChecker);
          
          // Trigger a final refresh to ensure transcript is available
          setTimeout(() => fetchJobs(), 500);
        } else if (targetJob && targetJob.status === 'failed') {
          console.log('Direct upload job failed:', jobId);
          clearInterval(completionChecker);
        } else if (!targetJob) {
          console.log('Direct upload job no longer found, stopping monitoring:', jobId);
          clearInterval(completionChecker);
        }
      } catch (error) {
        console.error('Error monitoring job completion:', error);
      }
    }, 2000); // Check every 2 seconds
    
    // Stop monitoring after 10 minutes max (cleanup safety)
    setTimeout(() => {
      clearInterval(completionChecker);
      console.log('Stopped monitoring job completion after timeout:', jobId);
    }, 600000); // 10 minutes
  }
  
  return result;
}

export async function uploadFromUrl(url, useLLM = false, webhookUrl = null, model = 'whisper-large-v3', chunkSizeMB = 10, debugSaveChunks = false) {
  const response = await fetch(API_BASE + '/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      url, 
      use_llm: useLLM, 
      webhook_url: webhookUrl,
      model,
      chunk_size_mb: chunkSizeMB,
      debug_save_chunks: debugSaveChunks
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }
  
  const result = await response.json();
  await fetchJobs(); // Refresh the jobs list immediately
  
  // For direct uploads, set up more frequent polling to catch completion faster
  if (result.job_id) {
    // Check for completion more frequently for this specific job
    const jobId = result.job_id;
    console.log('Setting up completion monitoring for URL upload job:', jobId);
    
    const completionChecker = setInterval(async () => {
      try {
        console.log('Checking URL upload job completion:', jobId);
        await fetchJobs();
        
        // Check if this specific job is now complete
        const currentJobs = get(jobs);
        const targetJob = currentJobs.find(job => job.job_id === jobId);
        
        if (targetJob && targetJob.status === 'done') {
          console.log('URL upload job completed:', jobId);
          clearInterval(completionChecker);
          
          // Trigger a final refresh to ensure transcript is available
          setTimeout(() => fetchJobs(), 500);
        } else if (targetJob && targetJob.status === 'failed') {
          console.log('URL upload job failed:', jobId);
          clearInterval(completionChecker);
        } else if (!targetJob) {
          console.log('URL upload job no longer found, stopping monitoring:', jobId);
          clearInterval(completionChecker);
        }
      } catch (error) {
        console.error('Error monitoring job completion:', error);
      }
    }, 2000); // Check every 2 seconds
    
    // Stop monitoring after 10 minutes max (cleanup safety)
    setTimeout(() => {
      clearInterval(completionChecker);
      console.log('Stopped monitoring job completion after timeout:', jobId);
    }, 600000); // 10 minutes
  }
  
  return result;
}

export async function deleteJob(jobId) {
  const currentJobs = get(jobs);
  const job = currentJobs.find(j => j.job_id === jobId);
  
  if (!job) {
    throw new Error('Job not found');
  }
  
  const initialJobCount = currentJobs.length;
  
  // Handle streaming jobs (they might be stored both locally AND on server)
  if (job.processing_method === 'streaming') {
    console.log('Deleting streaming job locally and from server');
    
    // Remove from local storage first
    const filteredJobs = currentJobs.filter(j => j.job_id !== jobId);
    jobs.set(filteredJobs);
    
    // Also try to delete from server (completed streaming jobs are saved to KV)
    // Don't await this - let it happen in background and don't fail if it errors
    fetch(API_BASE + '/delete-job', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ job_id: jobId })
    }).then(response => {
      if (response.ok) {
        webLogger.info('delete', 'Also deleted streaming job from server KV', { job_id: jobId });
      } else {
        // This is expected for local-only streaming jobs that haven't been saved to server
        webLogger.debug('Streaming job not found on server (local only)', { job_id: jobId });
      }
    }).catch(error => {
      webLogger.debug('Error deleting streaming job from server (likely local only)', { job_id: jobId, error: error.message });
    });
    
    console.log('Jobs after streaming deletion:', filteredJobs.length, 'removed:', initialJobCount - filteredJobs.length);
    webLogger.info('delete', 'Deleted streaming job locally', { job_id: jobId, count_before: initialJobCount, count_after: filteredJobs.length });
    return;
  }
  
  // Handle server-stored jobs
  const response = await fetch(API_BASE + '/delete-job', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ job_id: jobId })
  });
  
  if (response.ok) {
    console.log('Server deletion successful, removing from local array');
    const filteredJobs = currentJobs.filter(j => j.job_id !== jobId);
    jobs.set(filteredJobs);
    
    console.log('Jobs after server deletion:', filteredJobs.length, 'removed:', initialJobCount - filteredJobs.length);
    webLogger.info('delete', 'Deleted server job', { job_id: jobId, count_before: initialJobCount, count_after: filteredJobs.length });
  } else {
    const error = await response.json();
    console.error('Server deletion failed:', error);
    throw new Error(error.error || 'Delete failed');
  }
}

export async function deleteAllJobs() {
  const currentJobs = get(jobs);
  
  if (currentJobs.length === 0) {
    return;
  }
  
  webLogger.info('delete', 'Starting delete all jobs operation', { total_jobs: currentJobs.length });
  
  // Separate streaming jobs from server jobs
  const streamingJobs = currentJobs.filter(j => j.processing_method === 'streaming');
  const serverJobs = currentJobs.filter(j => j.processing_method !== 'streaming');
  
  // Clear all jobs from local store immediately for better UX
  jobs.set([]);
  
  // Handle streaming jobs - delete from server in background (best effort)
  if (streamingJobs.length > 0) {
    webLogger.info('delete', 'Deleting streaming jobs from server (background)', { count: streamingJobs.length });
    
    // Try to delete streaming jobs from server (don't await, fire and forget)
    streamingJobs.forEach(job => {
      fetch(API_BASE + '/delete-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id })
      }).catch(error => {
        webLogger.debug('Background streaming job deletion failed (expected for local-only jobs)', { 
          job_id: job.job_id, 
          error: error.message 
        });
      });
    });
  }
  
  // Handle server jobs - delete each one via API
  if (serverJobs.length > 0) {
    webLogger.info('delete', 'Deleting server jobs', { count: serverJobs.length });
    
    // Delete server jobs in parallel for better performance
    const deletePromises = serverJobs.map(job => 
      fetch(API_BASE + '/delete-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: job.job_id })
      }).catch(error => {
        webLogger.error('Failed to delete server job', error, { job_id: job.job_id });
        return null; // Continue with other deletions even if one fails
      })
    );
    
    // Wait for all deletions to complete (or fail)
    await Promise.allSettled(deletePromises);
  }
  
  webLogger.complete('Delete all jobs completed', { 
    streaming_jobs: streamingJobs.length,
    server_jobs: serverJobs.length,
    total: currentJobs.length
  });
}

export async function copyTranscript(jobId) {
  const currentJobs = get(jobs);
  const job = currentJobs.find(j => j.job_id === jobId);
  
  if (!job) {
    throw new Error('Job not found');
  }
  
  let transcriptText = '';
  
  // Handle streaming jobs differently since they're not stored on server
  if (job.processing_method === 'streaming') {
    transcriptText = job.final_transcript || job.corrected_transcript || job.raw_transcript || 'No transcript available';
  } else {
    const response = await fetch(API_BASE + '/result?job_id=' + jobId);
    if (response.ok) {
      const data = await response.json();
      transcriptText = data.final || 'No transcript available';
    } else {
      transcriptText = 'Failed to fetch transcript';
    }
  }
  
  await navigator.clipboard.writeText(transcriptText);
  return transcriptText;
}

export async function copyJobJson(jobId) {
  const currentJobs = get(jobs);
  const job = currentJobs.find(j => j.job_id === jobId);
  
  if (!job) {
    throw new Error('Job not found');
  }
  
  let fullJobData = { ...job };
  
  // For non-streaming jobs, fetch full data from server
  if (job.processing_method !== 'streaming') {
    try {
      const response = await fetch(API_BASE + '/result?job_id=' + jobId);
      if (response.ok) {
        const transcriptData = await response.json();
        fullJobData.transcript_data = transcriptData;
      }
    } catch (error) {
      webLogger.warn('Could not fetch full transcript data for JSON export', error);
    }
  }
  
  const jsonText = JSON.stringify(fullJobData, null, 2);
  await navigator.clipboard.writeText(jsonText);
  return jsonText;
} 

export async function saveStreamingJob(job) {
  try {
    const response = await fetch(API_BASE + '/save-streaming-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: job.job_id,
        filename: job.filename,
        file_size: job.file_size,
        final_transcript: job.final_transcript,
        raw_transcript: job.raw_transcript,
        corrected_transcript: job.corrected_transcript,
        total_segments: job.total_segments,
        created_at: job.created_at,
        completed_at: job.completed_at,
        use_llm: job.use_llm,
        llm_mode: job.llm_mode,
        chunk_size_mb: job.chunk_size_mb,
        source_url: job.source_url || null,
        transcripts: job.transcripts || []
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to save streaming job');
    }
    
    webLogger.info('api', 'Saved streaming job to server', { job_id: job.job_id });
  } catch (error) {
    webLogger.error('Failed to save streaming job to server', error);
  }
}

// ============================================================================
// CHUNKED STREAMING API FUNCTIONS
// ============================================================================

// Helper function to extract file extension
function getFileExtension(filename) {
  if (!filename) return 'mp3';
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext || 'mp3';
}

export async function initializeChunkedUpload(options) {
  const {
    filename,
    file,
    url,
    chunkSizeMB = 10,
    useLLM = false,
    llmMode = 'per_chunk',
    model = 'whisper-large-v3',
    debugSaveChunks = false
  } = options;

  // NEW: Use full file upload with server-side audio-aware chunking
  if (file) {
    // Upload the complete file and let server do audio-aware chunking
    const formData = new FormData();
    formData.append('file', file);
    formData.append('chunk_size_mb', chunkSizeMB.toString());
    formData.append('use_llm', useLLM.toString());
    formData.append('model', model);
    formData.append('debug_save_chunks', debugSaveChunks.toString());
    
    if (useLLM) {
      formData.append('llm_mode', llmMode);
    }

    const response = await fetch(API_BASE + '/chunked-upload-stream', {
      method: 'POST',
      body: formData // Send as FormData to trigger new server-side chunking mode
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize chunked upload: ${errorText}`);
    }

    const result = await response.json();
    console.log('✅ Server-side audio-aware chunking completed:', {
      total_chunks: result.chunk_info.total_chunks,
      chunking_method: result.chunk_info.chunking_method,
      playable_chunks: result.chunk_info.playable_chunks
    });
    
    return result;
  }
  
  // EXISTING: URL-based uploads still use JSON mode
  if (url) {
    const payload = {
      filename,
      url,
      chunk_size_mb: chunkSizeMB,
      use_llm: useLLM,
      model,
      debug_save_chunks: debugSaveChunks
    };

    if (useLLM) {
      payload.llm_mode = llmMode;
    }

    const response = await fetch(API_BASE + '/chunked-upload-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to initialize chunked upload: ${errorText}`);
    }

    const result = await response.json();
    return result;
  }
  
  throw new Error('Either file or url must be provided');
}

export async function uploadChunksInParallel(file, uploadUrls, parentJobId, maxConcurrent = 3) {
  console.log('uploadChunksInParallel called:', {
    fileSize: file.size,
    uploadUrlsLength: uploadUrls?.length,
    parentJobId,
    maxConcurrent
  });

  if (!uploadUrls || uploadUrls.length === 0) {
    throw new Error('No upload URLs provided');
  }

  let completedUploads = 0;
  const totalUploads = uploadUrls.length;
  
  // Use a local counter only - don't interfere with SSE progress updates
  const uploadTracker = {
    completed: 0,
    total: totalUploads,
    updateProgress() {
      this.completed++;
      console.log(`📊 Local upload tracker: ${this.completed}/${this.total} completed`);
      
      // DON'T update global stores here - let SSE handle all progress updates
      // This prevents the race condition between client and server progress
      console.log('📊 Letting SSE handle all progress updates to avoid race conditions');
       
      // Only dispatch a local event for immediate UI feedback if needed
      const forceUpdateEvent = new CustomEvent('chunk-upload-complete', {
        detail: { uploaded: this.completed, total: this.total }
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(forceUpdateEvent);
      }
       
      return this.completed;
    }
  };

  const uploadPromises = uploadUrls.map(async (urlInfo, index) => {
    console.log(`Starting upload for chunk ${index}:`, {
      chunkIndex: urlInfo.chunk_index,
      byteRange: urlInfo.byte_range,
      uploadUrl: urlInfo.upload_url,
      parentJobId: urlInfo.parent_job_id
    });

    // Extract chunk data from file
    const chunkStart = urlInfo.byte_range[0];
    const chunkEnd = urlInfo.byte_range[1] + 1; // byte_range is inclusive, slice is exclusive
    
    // Validate byte ranges
    if (chunkStart < 0 || chunkEnd > file.size || chunkStart >= chunkEnd) {
      throw new Error(`Invalid byte range for chunk ${urlInfo.chunk_index}: [${chunkStart}, ${chunkEnd}) with file size ${file.size}`);
    }
    
    const chunk = file.slice(chunkStart, chunkEnd);
    
    // Enhanced debugging for chunk 0 to detect corruption
    if (urlInfo.chunk_index === 0) {
      console.log(`🔍 Chunk 0 detailed analysis:`, {
        originalFileSize: file.size,
        originalFileType: file.type,
        chunkStart,
        chunkEnd,
        sliceLength: chunkEnd - chunkStart,
        actualChunkSize: chunk.size,
        expectedSize: urlInfo.expected_size
      });
      
      // Read first few bytes of chunk 0 to check for corruption
      const reader = new FileReader();
      const firstBytes = await new Promise((resolve, reject) => {
        reader.onload = e => resolve(new Uint8Array(e.target.result));
        reader.onerror = reject;
        reader.readAsArrayBuffer(chunk.slice(0, Math.min(64, chunk.size)));
      });
      
      const zeroCount = Array.from(firstBytes).filter(byte => byte === 0).length;
      const zeroPercentage = (zeroCount / firstBytes.length) * 100;
      
      console.log(`🔍 Chunk 0 content analysis:`, {
        first64Bytes: Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' '),
        zeroCount,
        zeroPercentage: zeroPercentage.toFixed(1),
        suspicious: zeroPercentage > 25 // More than 25% zeros is suspicious for MP3
      });
      
      if (zeroPercentage > 25) {
        console.warn(`⚠️ Chunk 0 has ${zeroPercentage.toFixed(1)}% zeros - possible corruption!`);
      }
    }
    
    console.log(`Chunk ${index} data:`, {
      chunkIndex: urlInfo.chunk_index,
      chunkSize: chunk.size,
      expectedStart: chunkStart,
      expectedEnd: chunkEnd,
      expectedSize: urlInfo.expected_size,
      sizeMatch: chunk.size === urlInfo.expected_size
    });
    
    try {
      // Upload chunk to Worker (instead of directly to R2)
      console.log(`Uploading chunk ${urlInfo.chunk_index} to Worker...`);
      
      // Create explicit blob with proper MIME type to prevent FormData issues
      const chunkBlob = new Blob([chunk], { 
        type: file.type || 'audio/mpeg' // Use original file type or default to audio/mpeg
      });
      
      if (urlInfo.chunk_index === 0) {
        console.log(`🔍 Chunk 0 FormData details:`, {
          originalFileType: file.type,
          chunkBlobType: chunkBlob.type,
          chunkBlobSize: chunkBlob.size,
          chunkSize: chunk.size,
          sizesMatch: chunkBlob.size === chunk.size
        });
      }
      
      const formData = new FormData();
      formData.append('chunk', chunkBlob, `chunk.${urlInfo.chunk_index}.${getFileExtension(file.name || 'audio.mp3')}`);
      formData.append('parent_job_id', parentJobId);
      formData.append('chunk_index', urlInfo.chunk_index.toString());
      formData.append('expected_size', urlInfo.expected_size.toString());
      
      const uploadResponse = await fetch(API_BASE + urlInfo.upload_url, {
        method: 'POST',
        body: formData
      });
      
      console.log(`Chunk ${urlInfo.chunk_index} upload response:`, {
        status: uploadResponse.status,
        statusText: uploadResponse.statusText,
        ok: uploadResponse.ok
      });
      
      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorData.error || 'Unknown error'}`);
      }
      
      const responseData = await uploadResponse.json();
      console.log(`Chunk ${urlInfo.chunk_index} completed successfully:`, responseData);
      
      // Update local tracking only - SSE will handle global progress
      const currentCount = uploadTracker.updateProgress();
      
      // Update chunk slot to show upload complete (this is safe since it's per-chunk)
      console.log(`📊 Updating chunk slot ${urlInfo.chunk_index} to processing`);
      updateChunkSlot(urlInfo.chunk_index, {
        status: 'processing', // Mark as processing since upload is done
        uploadProgress: 100
      });
      
      return {
        chunkIndex: urlInfo.chunk_index,
        success: true,
        size: chunk.size,
        response: responseData
      };
      
    } catch (error) {
      console.error(`Chunk ${urlInfo.chunk_index} failed:`, error);
      return {
        chunkIndex: urlInfo.chunk_index,
        success: false,
        error: error.message
      };
    }
  });
  
  console.log(`Starting ${uploadPromises.length} concurrent uploads...`);
  
  // Use Promise.allSettled to handle concurrent uploads with some failures
  const results = await Promise.allSettled(uploadPromises);
  
  console.log('All upload promises settled:', results);
  
  const finalResults = results.map(result => 
    result.status === 'fulfilled' ? result.value : {
      success: false,
      error: result.reason?.message || 'Upload failed'
    }
  );
  
  console.log('Final upload results:', finalResults);
  
  return finalResults;
}

export async function createChunkedStreamEventSource(parentJobId) {
  const eventSource = new EventSource(`${API_BASE}/chunked-stream/${parentJobId}`);
  return eventSource;
}

export async function retryChunkUpload(parentJobId, chunkIndex) {
  const response = await fetch(API_BASE + '/chunked-upload-retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_job_id: parentJobId,
      chunk_index: chunkIndex
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to retry chunk upload');
  }
  
  return await response.json();
}

export async function cancelChunkedUpload(parentJobId) {
  const response = await fetch(API_BASE + '/chunked-upload-cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      parent_job_id: parentJobId,
      reason: 'user_cancelled'
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to cancel chunked upload');
  }
  
  return await response.json();
} 