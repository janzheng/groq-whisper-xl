<script>
  import { 
    isStreaming, showStreamingResults, formatBytes, jobs, currentStreamingFilename, 
    streamStartTime, streamingProgress, streamingTranscript, chunksProcessed, totalChunks, 
    streamingFileSize, streamingLLMMode,
    // Chunked streaming stores
    isChunkedStreaming, showChunkedStreamingResults, chunkedStreamingMode, chunkSlots, chunkedViewMode, 
    chunkedProgress, chunkedReadableTranscript, currentChunkedJobId,
    chunkedTotalChunks, chunkedUploadedChunks, chunkedCompletedChunks, 
    chunkedFailedChunks, chunkedSuccessRate,
    initializeChunkSlots, updateChunkSlot, resetChunkedStreaming
  } from '../lib/stores.js';
  import { streamLogger } from '../lib/logger.js';
  import { get } from 'svelte/store';
  import { saveStreamingJob, initializeChunkedUpload, uploadChunksInParallel, createChunkedStreamEventSource } from '../lib/api.js';
  import { fetchJobs } from '../lib/api.js';

  let sourceMode = 'file'; // 'file' or 'url'
  let selectedFile = null;
  let url = '';
  let chunkSizeMB = 0.25;
  let chunkedChunkSizeMB = 5; // Different default for chunked mode
  let llmMode = 'disabled'; // 'disabled', 'per_chunk', 'post_process'
  let uploadAreaElement;
  let fileInput;
  let uploadAreaContent = getDefaultUploadAreaContent();
  
  // Streaming state
  let currentAbortController = null;
  let elapsedTime = 0;
  let elapsedTimer = null;
  
  // Chunked streaming state
  let chunkedEventSource = null;
  
  function getDefaultUploadAreaContent() {
    return {
      icon: 'mdi:file-plus',
      title: 'Drop files here or click to browse',
      subtitle: 'MP3, WAV, M4A, FLAC, etc. (up to 1GB)'
    };
  }
  
  function updateUploadAreaWithFile(file) {
    const mode = $chunkedStreamingMode ? 'chunked' : 'streaming';
    const description = $chunkedStreamingMode 
      ? 'Click "Chunked Stream" to upload in chunks with real-time processing'
      : 'Click "Live Transcribe" to start';
      
    uploadAreaContent = {
      icon: 'mdi:file-music',
      title: file.name,
      subtitle: `Ready to ${mode} transcribe (${formatBytes(file.size)})`,
      description: description
    };
    selectedFile = file;
  }
  
  function resetUploadArea() {
    uploadAreaContent = getDefaultUploadAreaContent();
    selectedFile = null;
    if (fileInput) fileInput.value = '';
  }
  
  function handleDragOver(e) {
    e.preventDefault();
    if (uploadAreaElement) {
      uploadAreaElement.classList.add('border-terminal-accent', 'bg-green-900/20');
      uploadAreaElement.classList.remove('border-terminal-border');
    }
  }
  
  function handleDragLeave() {
    if (uploadAreaElement) {
      uploadAreaElement.classList.remove('border-terminal-accent', 'bg-green-900/20');
      uploadAreaElement.classList.add('border-terminal-border');
    }
  }
  
  function handleDrop(e) {
    e.preventDefault();
    handleDragLeave();
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      updateUploadAreaWithFile(files[0]);
    }
  }
  
  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      updateUploadAreaWithFile(files[0]);
    }
  }
  
  function triggerFileSelect() {
    if (fileInput) fileInput.click();
  }
  
  function setSourceMode(mode) {
    sourceMode = mode;
    if (mode === 'file') {
      resetUploadArea();
    }
  }
  
  // Update upload area when chunked mode changes
  $: if (selectedFile) {
    updateUploadAreaWithFile(selectedFile);
  }
  
  function getButtonText() {
    if ($isStreaming || $isChunkedStreaming) {
      const filename = $isChunkedStreaming ? $currentChunkedJobId : $currentStreamingFilename;
      const mode = $isChunkedStreaming ? 'Chunked Streaming' : 'Streaming';
      return `🔄 ${mode} ${filename}...`;
    }
    
    if (sourceMode === 'file') {
      if ($chunkedStreamingMode) {
        return selectedFile ? `Chunked Stream ${selectedFile.name}` : 'Select File for Chunked Streaming';
      } else {
        return selectedFile ? `Live Transcribe ${selectedFile.name}` : 'Select File to Transcribe';
      }
    } else {
      return $chunkedStreamingMode ? 'Chunked Stream URL' : 'Live Transcribe URL';
    }
  }
  
  function startNewStreaming() {
    // Reset appropriate results display when starting a new job
    if ($chunkedStreamingMode) {
      resetChunkedStreaming();
    } else {
      $showStreamingResults = false;
    }
    
    // Brief delay to allow the display to hide, then start new streaming
    setTimeout(() => {
      if ($chunkedStreamingMode) {
        handleStartChunkedStreaming();
      } else {
        handleStartStreaming();
      }
    }, 100);
  }
  
  function startElapsedTimer() {
    $streamStartTime = Date.now();
    elapsedTimer = setInterval(() => {
      elapsedTime = Math.floor((Date.now() - $streamStartTime) / 1000);
    }, 1000);
  }
  
  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  // ============================================================================
  // CHUNKED STREAMING FUNCTIONS
  // ============================================================================
  
  async function handleStartChunkedStreaming() {
    if ($isChunkedStreaming) return;
    
    let options = {
      chunkSizeMB: chunkedChunkSizeMB,
      useLLM: llmMode !== 'disabled'
    };
    
    // Only pass llm_mode if LLM is enabled
    if (llmMode !== 'disabled') {
      options.llmMode = llmMode;
    }
    
    // Prepare options based on source mode
    if (sourceMode === 'file') {
      if (!selectedFile) {
        triggerFileSelect();
        return;
      }
      options.filename = selectedFile.name;
      options.file = selectedFile;
    } else if (sourceMode === 'url') {
      if (!url.trim()) {
        alert('Please enter an audio URL first');
        return;
      }
      options.url = url.trim();
      options.filename = url.split('/').pop() || 'audio file';
    }
    
    try {
      // Initialize chunked upload
      const result = await initializeChunkedUpload(options);
      
      $isChunkedStreaming = true;
      $showChunkedStreamingResults = true;
      $currentChunkedJobId = result.parent_job_id;
      $chunkedTotalChunks = result.chunk_info.total_chunks;
      
      // Initialize chunk slots
      initializeChunkSlots(result.chunk_info.total_chunks);
      
      startElapsedTimer();
      
      // Start SSE stream for real-time updates
      chunkedEventSource = await createChunkedStreamEventSource(result.parent_job_id);
      chunkedEventSource.onmessage = handleChunkedStreamEvent;
      chunkedEventSource.onerror = handleChunkedStreamError;
      
      // Start uploading chunks if we have a file
      if (options.file) {
        try {
          const uploadResults = await uploadChunksInParallel(
            options.file, 
            result.upload_urls, 
            result.parent_job_id,
            3 // max concurrent uploads
          );
          
          // Check for upload failures
          const failures = uploadResults.filter(r => !r.success);
          if (failures.length > 0) {
            console.error('Some chunks failed to upload:', failures);
            streamLogger.error('Some chunks failed to upload', { failures });
          }
          
        } catch (uploadError) {
          console.error('Upload chunks failed:', uploadError);
          streamLogger.error('Upload chunks failed', uploadError);
          alert(`Upload failed: ${uploadError.message}`);
          stopChunkedStreaming();
          return;
        }
      } else {
        console.log('No file provided, expecting URL upload handling');
      }
      
    } catch (error) {
      streamLogger.error('Chunked streaming failed', error);
      console.error('Chunked streaming error:', error);
      alert(`Chunked streaming failed: ${error.message}`);
      stopChunkedStreaming();
    }
  }
  
  function handleChunkedStreamEvent(event) {
    try {
      const data = JSON.parse(event.data);
      handleChunkedEvent(data);
    } catch (error) {
      console.error('Failed to parse chunked SSE data:', error, event.data);
    }
  }
  
  function handleChunkedStreamError(error) {
    console.log('Chunked SSE error event:', error);
    
    // Check if this is just a normal stream closure after completion
    if (chunkedEventSource && chunkedEventSource.readyState === EventSource.CLOSED) {
      // Stream closed normally after completion - this is expected
      streamLogger.info('Chunked stream closed after completion', { 
        readyState: chunkedEventSource.readyState 
      });
      
      // Only log as error if we're still expecting the stream to be active
      if ($isChunkedStreaming) {
        streamLogger.warn('Chunked stream closed unexpectedly while still processing');
      }
      
      return;
    }
    
    // This is an actual error
    streamLogger.error('Chunked stream error', error);
    console.error('Chunked SSE error:', error);
    
    // Only show user-facing error if we're still actively streaming
    if ($isChunkedStreaming) {
      alert('Stream connection lost. Check console for details.');
    }
  }
  
  async function handleChunkedEvent(data) {
    switch (data.type) {
      case 'initialized':
        $chunkedTotalChunks = data.total_chunks;
        streamLogger.info('Chunked upload initialized', { 
          parent_job_id: data.parent_job_id,
          total_chunks: data.total_chunks
        });
        break;
        
      case 'progress_update':
        $chunkedProgress = {
          upload: data.upload_progress || 0,
          processing: data.processing_progress || 0,
          overall: data.progress || 0
        };
        $chunkedUploadedChunks = data.uploaded_chunks || 0;
        $chunkedCompletedChunks = data.completed_chunks || 0;
        $chunkedFailedChunks = data.failed_chunks || 0;
        $chunkedSuccessRate = data.success_rate || 0;
        break;
        
      case 'chunk_complete':
        // Update the specific chunk slot with completion data
        updateChunkSlot(data.chunk_index, {
          status: 'complete',
          text: data.text,
          rawText: data.raw_text || data.text,
          correctedText: data.corrected_text,
          processingTime: data.processing_time,
          llmApplied: data.llm_applied || false
        });
        
        // Update readable transcript if we're in order mode or if this creates a contiguous sequence
        updateReadableTranscript();
        break;
        
      case 'chunk_failed':
        updateChunkSlot(data.chunk_index, {
          status: 'failed',
          error: data.error
        });
        break;
        
      case 'partial_transcript':
        $chunkedReadableTranscript = data.partial_transcript;
        break;
        
      case 'final_result':
        // Mark job as completed
        $chunkedProgress = { upload: 100, processing: 100, overall: 100 };
        
        // Update the job in the jobs list
        const currentJobs = get(jobs);
        const jobIndex = currentJobs.findIndex(job => job.job_id === data.parent_job_id);
        if (jobIndex !== -1) {
          currentJobs[jobIndex] = {
            ...currentJobs[jobIndex],
            status: 'done',
            final_transcript: data.final_transcript,
            raw_transcript: data.raw_transcript,
            corrected_transcript: data.corrected_transcript,
            completed_at: new Date().toISOString(),
            progress: 100,
            success_rate: data.success_rate,
            transcripts: [{
              text: data.final_transcript,
              raw_text: data.raw_transcript,
              segments: [],
              start: 0,
              duration: currentJobs[jobIndex].file_size || 0,
              chunk_index: 'chunked_streaming'
            }]
          };
          jobs.set(currentJobs);
        }
        
        streamLogger.complete('Chunked streaming completed', {
          parent_job_id: data.parent_job_id,
          success_rate: data.success_rate,
          transcript_length: data.final_transcript?.length || 0
        });
        
        // Refresh jobs list to show the completed chunked upload job
        try {
          // Trigger multiple jobs refreshes to ensure the chunked job is captured
          // Sometimes the server needs a moment to fully process the completion
          const refreshAttempts = [500, 1500, 3000]; // Try at 0.5s, 1.5s, and 3s
          refreshAttempts.forEach((delay, index) => {
            setTimeout(async () => {
              try {
                await fetchJobs();
                streamLogger.info(`Jobs refresh attempt ${index + 1} completed after chunked streaming`);
              } catch (refreshError) {
                streamLogger.error(`Jobs refresh attempt ${index + 1} failed after chunked streaming`, refreshError);
              }
            }, delay);
          });
        } catch (error) {
          streamLogger.error('Failed to refresh jobs after chunked streaming', error);
        }
        
        // Set show results flag and clean up streaming state
        $showChunkedStreamingResults = true;
        $isChunkedStreaming = false;
        
        // Close event source but keep results visible
        if (chunkedEventSource) {
          streamLogger.info('Closing chunked stream after completion', { 
            readyState: chunkedEventSource.readyState 
          });
          
          // Remove event listeners before closing to prevent error events
          chunkedEventSource.onmessage = null;
          chunkedEventSource.onerror = null;
          chunkedEventSource.onopen = null;
          
          // Close the connection
          chunkedEventSource.close();
          chunkedEventSource = null;
        }
        
        stopElapsedTimer();
        
        // Reset form state after a brief delay
        setTimeout(() => {
          if (sourceMode === 'file') {
            resetUploadArea();
          } else {
            url = '';
          }
        }, 2000);
        break;
        
      case 'job_terminated':
        streamLogger.error('Chunked job terminated', { 
          reason: data.reason,
          status: data.status 
        });
        stopChunkedStreaming();
        break;
    }
  }
  
  function updateReadableTranscript() {
    const slots = get(chunkSlots);
    
    // Build readable transcript from contiguous completed chunks starting from 0
    let readable = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      
      if (!slot || slot.status !== 'complete' || !slot.text) {
        break; // Stop at first gap or incomplete chunk
      }
      
      const text = $chunkedViewMode === 'speed' && slot.correctedText 
        ? slot.correctedText 
        : slot.text;
      
      readable += (readable ? ' ' : '') + text;
    }
    
    $chunkedReadableTranscript = readable;
  }
  
  function stopChunkedStreaming() {
    if (chunkedEventSource) {
      streamLogger.info('Closing chunked stream', { 
        readyState: chunkedEventSource.readyState 
      });
      
      // Remove event listeners before closing to prevent error events
      chunkedEventSource.onmessage = null;
      chunkedEventSource.onerror = null;
      chunkedEventSource.onopen = null;
      
      // Close the connection
      chunkedEventSource.close();
      chunkedEventSource = null;
    }
    
    $isChunkedStreaming = false;
    stopElapsedTimer();
    
    // Reset form state after a brief delay
    setTimeout(() => {
      if (sourceMode === 'file') {
        resetUploadArea();
      } else {
        url = '';
      }
    }, 2000);
  }

  // ============================================================================
  // REGULAR STREAMING FUNCTIONS (existing code)
  // ============================================================================
  
  async function handleStartStreaming() {
    if ($isStreaming) return;
    
    let requestOptions;
    let filename;
    
    // Prepare request based on source mode
    if (sourceMode === 'file') {
      if (!selectedFile) {
        triggerFileSelect();
        return;
      }
      
      filename = selectedFile.name;
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('chunk_size_mb', chunkSizeMB.toString());
      
      if (llmMode !== 'disabled') {
        formData.append('use_llm', 'true');
        formData.append('llm_mode', llmMode);
      } else {
        formData.append('use_llm', 'false');
      }
      
      requestOptions = {
        method: 'POST',
        body: formData
      };
      
    } else if (sourceMode === 'url') {
      if (!url.trim()) {
        alert('Please enter an audio URL first');
        return;
      }
      
      filename = url.split('/').pop() || 'audio file';
      const payload = {
        url: url.trim(),
        chunk_size_mb: chunkSizeMB
      };
      
      if (llmMode !== 'disabled') {
        payload.use_llm = true;
        payload.llm_mode = llmMode;
      } else {
        payload.use_llm = false;
      }
      
      requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      };
    }
    
    // Start streaming
    await startStreaming('/stream', requestOptions, filename);
  }
  
  async function startStreaming(endpoint, requestOptions, filename) {
    if ($isStreaming) return;
    
    $isStreaming = true;
    $showStreamingResults = true;
    $currentStreamingFilename = filename;
    $streamingTranscript = '';
    $streamingProgress = 0;
    $chunksProcessed = 0;
    $totalChunks = 0;
    $streamingFileSize = '';
    
    // Initialize LLM mode
    $streamingLLMMode = llmMode;
    
    startElapsedTimer();
    
    // Create a preliminary streaming job
    const preliminaryStreamingJob = {
      job_id: 'stream_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      filename: filename,
      status: 'processing',
      file_size: 0,
      processing_method: 'streaming',
      upload_method: 'streaming',
      created_at: new Date().toISOString(),
      use_llm: llmMode !== 'disabled',
      llm_mode: llmMode,
      chunk_size_mb: chunkSizeMB,
      progress: 0
    };
    
    // Add to jobs list immediately
    const currentJobs = get(jobs);
    jobs.set([preliminaryStreamingJob, ...currentJobs]);
    
    // Create abort controller
    currentAbortController = new AbortController();
    requestOptions.signal = currentAbortController.signal;
    
    // Initialize transcript display
    $streamingTranscript = '🚀 Starting transcription...\n\n';
    
    try {
      const response = await fetch(endpoint, requestOptions);
      
      if (!response.ok) {
        throw new Error('Streaming failed: ' + response.status);
      }
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          streamLogger.complete('Stream reader reached end');
          break;
        }
        
        if (!$isStreaming) {
          streamLogger.info('warning', 'Stream stopped by user');
          break;
        }
        
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              await handleStreamEvent(data);
            } catch (error) {
              console.error('Failed to parse SSE data:', error, line);
            }
          }
        }
      }
      
    } catch (error) {
      if (error.name === 'AbortError') {
        streamLogger.info('stream', 'Stream aborted by user');
        $streamingTranscript += '\n❌ Streaming stopped by user\n';
      } else {
        streamLogger.error('Streaming failed', error);
        $streamingTranscript += `\n❌ Streaming failed: ${error.message}\n`;
      }
    } finally {
      stopStreaming();
    }
  }
  
  async function handleStreamEvent(data) {
    const currentJobs = get(jobs);
    const currentStreamingJob = currentJobs.find(job => 
      job.processing_method === 'streaming' && 
      job.filename === $currentStreamingFilename &&
      job.status === 'processing'
    );
    
    switch (data.type) {
      case 'status':
        $streamingTranscript += `📡 ${data.message}\n`;
        if (currentStreamingJob && data.job_id && currentStreamingJob.job_id.startsWith('stream_')) {
          currentStreamingJob.job_id = data.job_id;
          currentStreamingJob.file_size = data.total_size;
          currentStreamingJob.estimated_chunks = data.estimated_chunks;
          jobs.set(currentJobs);
        }
        if (data.total_size) {
          $streamingFileSize = formatBytes(data.total_size);
        }
        break;
        
      case 'chunk_info':
        $totalChunks = data.total_chunks;
        $streamingTranscript += `🧩 Ready to process ${data.total_chunks} chunks (${data.chunk_size_mb}MB each)\n\n`;
        break;
        
      case 'chunk_start':
        $streamingProgress = data.progress;
        $streamingTranscript += `🔄 Chunk ${data.chunk_index + 1} (${data.progress}%) - transcribing...\n`;
        
        if (currentStreamingJob) {
          currentStreamingJob.progress = data.progress;
          jobs.set(currentJobs);
        }
        break;
        
      case 'delta':
        if (data.llm_applied) {
          $streamingTranscript += `📝 Raw: "${data.raw_text}"\n`;
          $streamingTranscript += `🧠 LLM: "${data.corrected_text}"\n\n`;
        } else if (data.llm_error) {
          $streamingTranscript += `📝 "${data.raw_text}"\n`;
          $streamingTranscript += `⚠️  LLM failed: ${data.llm_error}\n\n`;
        } else {
          const text = data.text || data.raw_text;
          $streamingTranscript += `📝 "${text}"\n\n`;
        }
        
        $chunksProcessed = $chunksProcessed + 1;
        break;
        
      case 'chunk_done':
        $streamingProgress = data.progress;
        $streamingTranscript += `✅ Chunk ${data.chunk_index + 1} completed (${data.progress}%)\n\n`;
        break;
        
      case 'chunk_error':
        $streamingTranscript += `❌ Chunk ${data.chunk_index + 1} error: ${data.error}\n\n`;
        break;
        
      case 'llm_processing':
        const mode = data.mode === 'post_process' ? 'post-processing' : 'per-chunk';
        $streamingTranscript += `🧠 ${data.message || (`Applying LLM corrections (${mode})...`)}\n`;
        break;
        
      case 'llm_done':
        const doneMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
        $streamingTranscript += `✅ ${doneMode} LLM correction completed\n`;
        if (data.mode === 'post_process') {
          $streamingTranscript += `📝 Improved transcript:\n"${data.corrected_text}"\n\n`;
        }
        break;
        
      case 'llm_error':
        const errorMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
        $streamingTranscript += `❌ ${errorMode} LLM correction failed: ${data.error}\n`;
        if (data.fallback_text) {
          $streamingTranscript += `📝 Using original transcript: "${data.fallback_text}"\n\n`;
        }
        break;
        
      case 'done':
        $streamingTranscript += `\n🎉 Transcription complete!\n`;
        $streamingTranscript += `📊 Final transcript: "${data.final_transcript}"\n`;
        
        // Find the streaming job that's completing (it's still 'processing' at this point)
        const completingJob = currentJobs.find(job => 
          job.processing_method === 'streaming' && 
          job.filename === $currentStreamingFilename &&
          job.status === 'processing'
        );
        
        // Update the streaming job with completion data
        if (completingJob) {
          completingJob.status = 'done';
          completingJob.final_transcript = data.final_transcript;
          completingJob.raw_transcript = data.raw_transcript;
          completingJob.corrected_transcript = data.corrected_transcript;
          completingJob.total_segments = data.total_segments;
          completingJob.completed_at = new Date().toISOString();
          completingJob.progress = 100;
          
          // Add transcripts array to match direct upload format
          completingJob.transcripts = [{
            text: data.final_transcript,
            raw_text: data.raw_transcript,
            segments: [], // Streaming doesn't provide detailed segments
            start: 0,
            duration: completingJob.file_size || 0,
            chunk_index: 'streaming'
          }];
          
          jobs.set(currentJobs);
          
          // Save to server
          try {
            await saveStreamingJob(completingJob);
            streamLogger.info('Saved streaming job to server', { job_id: completingJob.job_id });
            
            // Trigger multiple jobs refreshes to ensure the update is captured
            // Sometimes the server needs a moment to fully process the save
            const refreshAttempts = [500, 1500, 3000]; // Try at 0.5s, 1.5s, and 3s
            refreshAttempts.forEach((delay, index) => {
              setTimeout(async () => {
                try {
                  await fetchJobs();
                  streamLogger.info(`Jobs refresh attempt ${index + 1} completed after streaming`);
                } catch (refreshError) {
                  streamLogger.error(`Jobs refresh attempt ${index + 1} failed after streaming`, refreshError);
                }
              }, delay);
            });
            
          } catch (error) {
            streamLogger.error('Failed to save streaming job to server', error);
            // Still try to refresh even if save failed, in case the job was saved during streaming
            setTimeout(async () => {
              try {
                await fetchJobs();
                streamLogger.info('Attempted jobs refresh after save failure');
              } catch (refreshError) {
                streamLogger.error('Failed to refresh jobs after save failure', refreshError);
              }
            }, 1000); // Longer delay for error case
          }
          
          streamLogger.complete('Streaming job completed', {
            job_id: completingJob.job_id,
            filename: $currentStreamingFilename,
            transcript_length: data.final_transcript?.length || 0
          });
        }
        break;
        
      case 'error':
        $streamingTranscript += `\n❌ Error: ${data.error}\n`;
        
        // Find the streaming job that's failing (it's still 'processing' at this point)
        const failingJob = currentJobs.find(job => 
          job.processing_method === 'streaming' && 
          job.filename === $currentStreamingFilename &&
          job.status === 'processing'
        );
        
        // Mark job as failed
        if (failingJob) {
          failingJob.status = 'failed';
          failingJob.error = data.error;
          failingJob.failed_at = new Date().toISOString();
          jobs.set(currentJobs);
        }
        break;
    }
  }
  
  function stopStreaming() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    
    $isStreaming = false;
    // Don't reset $showStreamingResults - keep it visible!
    // Don't reset $currentStreamingFilename - keep it for display
    stopElapsedTimer();
    
    // Reset form state after a brief delay
    setTimeout(() => {
      if (sourceMode === 'file') {
        resetUploadArea();
      } else {
        url = '';
      }
    }, 2000);
  }
  
  function stopCurrentOperation() {
    if ($isChunkedStreaming) {
      stopChunkedStreaming();
    } else if ($isStreaming) {
      stopStreaming();
    }
  }
</script>

<!-- Streaming Upload Section -->
<div class="border border-terminal-border p-4 flex flex-col">
  <div class="flex items-center gap-2 mb-4 font-bold text-terminal-accent">
    <iconify-icon icon="mdi:waveform" class="text-lg"></iconify-icon>
    <span>Streaming Transcription</span>
  </div>
  <div class="text-xs text-terminal-text-dim mb-4">
    Real-time processing with live transcript streaming. See results as they're generated - perfect for demos and testing.
  </div>
  
  <!-- Source Selection -->
  <div class="mb-4">
    <div class="font-bold mb-2">Source:</div>
    <div class="flex gap-2 mb-3">
      <button 
        on:click={() => setSourceMode('file')}
        disabled={$isStreaming || $isChunkedStreaming}
        class="border border-terminal-border text-terminal-text px-4 py-2 hover:bg-yellow-400 transition-colors flex-1 flex items-center justify-center gap-2"
        class:bg-yellow-400={sourceMode === 'file'}
        class:bg-terminal-bg={sourceMode !== 'file'}
        class:opacity-50={$isStreaming || $isChunkedStreaming}
      >
        <iconify-icon icon="mdi:file-outline"></iconify-icon> File
      </button>
      <button 
        on:click={() => setSourceMode('url')}
        disabled={$isStreaming || $isChunkedStreaming}
        class="border border-terminal-border text-terminal-text px-4 py-2 hover:bg-yellow-400 transition-colors flex-1 flex items-center justify-center gap-2"
        class:bg-yellow-400={sourceMode === 'url'}
        class:bg-terminal-bg={sourceMode !== 'url'}
        class:opacity-50={$isStreaming || $isChunkedStreaming}
      >
        <iconify-icon icon="mdi:web"></iconify-icon> URL
      </button>
    </div>
    
    {#if sourceMode === 'file'}
      <!-- File Upload Area -->
      <div
        bind:this={uploadAreaElement}
        on:click={triggerFileSelect}
        on:keydown={(e) => e.key === 'Enter' && triggerFileSelect()}
        on:dragover={handleDragOver}
        on:dragleave={handleDragLeave}
        on:drop={handleDrop}
        role="button"
        tabindex="0"
        class="border-2 border-dashed border-terminal-border p-6 text-center cursor-pointer transition-all hover:border-terminal-accent hover:bg-gray-900/20"
        class:pointer-events-none={$isStreaming || $isChunkedStreaming}
        class:opacity-50={$isStreaming || $isChunkedStreaming}
      >
        <iconify-icon 
          icon={uploadAreaContent.icon} 
          class="text-3xl mb-2"
          class:text-terminal-text-dim={!uploadAreaContent.success && !uploadAreaContent.error}
          class:text-terminal-accent={uploadAreaContent.icon === 'mdi:file-music'}
          class:animate-spin={uploadAreaContent.icon === 'mdi:loading'}
        ></iconify-icon>
        <div class="font-bold">{uploadAreaContent.title}</div>
        <div class="text-xs"
             class:text-terminal-text-dim={!uploadAreaContent.success && !uploadAreaContent.error}
             class:text-terminal-accent={uploadAreaContent.icon === 'mdi:file-music'}
        >
          {uploadAreaContent.subtitle}
        </div>
        {#if uploadAreaContent.description}
          <div class="text-xs text-terminal-text-dim">{uploadAreaContent.description}</div>
        {/if}
      </div>
      <input 
        bind:this={fileInput}
        type="file" 
        accept="audio/*,video/*" 
        class="hidden"
        disabled={$isStreaming || $isChunkedStreaming}
        on:change={handleFileSelect}
      >
      
    {:else}
      <!-- URL input -->
      <input 
        bind:value={url}
        disabled={$isStreaming || $isChunkedStreaming}
        class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent" 
        class:opacity-50={$isStreaming || $isChunkedStreaming}
        type="url" 
        placeholder="https://example.com/audio.mp3"
      >
    {/if}
  </div>
  
  <!-- Settings -->
  <div class="mb-4 flex-1">
    <div class="font-bold mb-2">Settings:</div>
    <div class="space-y-3">
      <!-- Streaming Mode Toggle -->
      <div>
        <label class="text-terminal-text-dim block mb-1">Streaming mode:</label>
        <div class="flex gap-2">
          <button 
            type="button"
            on:click={() => $chunkedStreamingMode = false}
            disabled={$isStreaming || $isChunkedStreaming}
            class="border border-terminal-border text-terminal-text px-3 py-2 flex-1 hover:bg-yellow-400 transition-colors flex items-center justify-center gap-2"
            class:bg-yellow-400={!$chunkedStreamingMode}
            class:bg-terminal-bg={$chunkedStreamingMode}
            class:opacity-50={$isStreaming || $isChunkedStreaming}
          >
            <iconify-icon icon="mdi:waveform"></iconify-icon> Live Streaming
          </button>
          <button 
            type="button"
            on:click={() => $chunkedStreamingMode = true}
            disabled={$isStreaming || $isChunkedStreaming}
            class="border border-terminal-border text-terminal-text px-3 py-2 flex-1 hover:bg-yellow-400 transition-colors flex items-center justify-center gap-2"
            class:bg-yellow-400={$chunkedStreamingMode}
            class:bg-terminal-bg={!$chunkedStreamingMode}
            class:opacity-50={$isStreaming || $isChunkedStreaming}
          >
            <iconify-icon icon="mdi:package-variant"></iconify-icon> Chunked Upload
          </button>
        </div>
        <div class="text-xs text-terminal-text-dim mt-1">
          {#if $chunkedStreamingMode}
            Large files uploaded in chunks with parallel processing
          {:else}
            Real-time streaming for immediate feedback
          {/if}
        </div>
      </div>
      
      <div>
        <label for="chunk-size" class="text-terminal-text-dim block mb-1">
          {$chunkedStreamingMode ? 'Upload chunk size:' : 'Chunk size:'}
        </label>
        {#if $chunkedStreamingMode}
          <select 
            id="chunked-chunk-size"
            bind:value={chunkedChunkSizeMB}
            disabled={$isStreaming || $isChunkedStreaming}
            class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent"
            class:opacity-50={$isStreaming || $isChunkedStreaming}
          >
            <option value={5}>5MB (Recommended)</option>
            <option value={10}>10MB (Fewer chunks)</option>
            <option value={20}>20MB (Very large chunks)</option>
            <option value={50}>50MB (Maximum size)</option>
          </select>
        {:else}
          <select 
            id="chunk-size"
            bind:value={chunkSizeMB}
            disabled={$isStreaming || $isChunkedStreaming}
            class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent"
            class:opacity-50={$isStreaming || $isChunkedStreaming}
          >
            <option value={0.25}>0.25MB (Ultra-fast)</option>
            <option value={0.5}>0.5MB (Fast)</option>
            <option value={1}>1MB (Balanced)</option>
            <option value={2}>2MB (Fewer API calls)</option>
          </select>
        {/if}
      </div>
      
      <div>
        <label for="llm-mode" class="text-terminal-text-dim block mb-1">LLM correction:</label>
        <select 
          id="llm-mode"
          bind:value={llmMode}
          disabled={$isStreaming || $isChunkedStreaming}
          class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent"
          class:opacity-50={$isStreaming || $isChunkedStreaming}
        >
          <option value="disabled">Disabled (fastest)</option>
          <option value="per_chunk">Per-chunk (real-time)</option>
          <option value="post_process">Post-process (better quality)</option>
        </select>
      </div>
    </div>
  </div>
  
  <button 
    on:click={$isStreaming || $isChunkedStreaming ? stopCurrentOperation : startNewStreaming}
    class="px-4 py-2 transition-colors w-full font-bold flex items-center justify-center gap-2"
    class:bg-status-info={!$isStreaming && !$isChunkedStreaming}
    class:bg-status-error={$isStreaming || $isChunkedStreaming}
    class:text-terminal-bg={!$isStreaming && !$isChunkedStreaming || $isStreaming || $isChunkedStreaming}
    class:hover:bg-blue-500={!$isStreaming && !$isChunkedStreaming}
    class:hover:bg-red-600={$isStreaming || $isChunkedStreaming}
  >
    {#if $isStreaming || $isChunkedStreaming}
      <iconify-icon icon="mdi:stop"></iconify-icon> Stop Streaming
    {:else}
      <iconify-icon icon="mdi:waveform"></iconify-icon>
    {/if}
    {#if !$isStreaming && !$isChunkedStreaming}
      {getButtonText()}
    {:else}
      Stop Streaming
    {/if}
  </button>
</div>

 