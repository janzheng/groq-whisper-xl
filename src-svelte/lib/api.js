import { jobs, API_BASE } from './stores.js';
import { webLogger } from './logger.js';
import { get } from 'svelte/store';

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
          // Job doesn't exist on server yet (streaming job or very recent upload)
          // Keep the local job as-is
          updatedJobs.push(localJob);
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

export async function uploadFile(file, useLLM, webhookUrl) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('use_llm', useLLM.toString());
  
  if (webhookUrl) {
    formData.append('webhook_url', webhookUrl);
  }
  
  const response = await fetch(API_BASE + '/upload', {
    method: 'POST',
    body: formData
  });
  
  if (response.ok) {
    const result = await response.json();
    
    // Add to jobs list immediately
    const currentJobs = get(jobs);
    const newJob = {
      job_id: result.job_id,
      filename: result.filename,
      status: 'processing', // Changed to 'processing' since it's queued immediately
      file_size: result.file_size,
      processing_method: result.processing_method,
      upload_method: 'direct',
      use_llm: useLLM,
      created_at: new Date().toISOString()
    };
    
    jobs.set([newJob, ...currentJobs]);
    return result;
  } else {
    const error = await response.json();
    throw new Error(error.error || 'Upload failed');
  }
}

export async function uploadFromUrl(url, useLLM, webhookUrl) {
  const payload = {
    url: url,
    use_llm: useLLM
  };
  
  if (webhookUrl) {
    payload.webhook_url = webhookUrl;
  }
  
  const response = await fetch(API_BASE + '/upload-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  if (response.ok) {
    const result = await response.json();
    
    // Add to jobs list immediately
    const currentJobs = get(jobs);
    const newJob = {
      job_id: result.job_id,
      filename: result.filename,
      status: 'processing', // Changed to 'processing' since it's queued immediately
      file_size: result.file_size,
      processing_method: result.processing_method,
      upload_method: 'url',
      source_url: result.source_url,
      use_llm: useLLM,
      created_at: new Date().toISOString()
    };
    
    jobs.set([newJob, ...currentJobs]);
    return result;
  } else {
    const error = await response.json();
    throw new Error(error.error || 'URL upload failed');
  }
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