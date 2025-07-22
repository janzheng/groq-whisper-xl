<script>
  import { 
    isStreaming, showStreamingResults, formatBytes, jobs, currentStreamingFilename, 
    streamStartTime, streamingProgress, streamingTranscript, chunksProcessed, totalChunks, 
    streamingFileSize, streamingLLMMode,
    // Chunked streaming stores
    isChunkedStreaming, showChunkedStreamingResults, chunkedStreamingMode, chunkSlots, chunkedViewMode, 
    chunkedProgress, chunkedReadableTranscript, currentChunkedJobId,
    chunkedTotalChunks, chunkedUploadedChunks, chunkedCompletedChunks, 
    chunkedFailedChunks, chunkedSuccessRate, chunkedFileSize,
    initializeChunkSlots, updateChunkSlot, resetChunkedStreaming
  } from '../lib/stores.js';
  import { streamLogger } from '../lib/logger.js';
  import { get } from 'svelte/store';
  import { saveStreamingJob, initializeChunkedUpload, uploadChunksInParallel, createChunkedStreamEventSource } from '../lib/api.js';
  import { fetchJobs } from '../lib/api.js';

  let sourceMode = 'file'; // 'file' or 'url'
  let selectedFile = null;
  let url = '';
  let chunkSizeMB = 10; // Default chunk size (10MB is smaller chunks than 20MB)
  let chunkedChunkSizeMB = 5; // Different default for chunked mode
  let llmMode = 'disabled'; // 'disabled', 'per_chunk', 'post_process'
  let selectedModel = 'whisper-large-v3'; // Default model
  let uploadAreaElement;
  let fileInput;
  let uploadAreaContent = getDefaultUploadAreaContent();
  
  // Available Whisper models
  const whisperModels = [
    { value: 'whisper-large-v3', label: 'Whisper Large v3 (Default)' },
    { value: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (Faster)' }
  ];
  
  // Streaming state
  let currentAbortController = null;
  let elapsedTime = 0;
  let elapsedTimer = null;
  
  // Chunked streaming state
  let chunkedEventSource = null;
  let currentChunkedFilename = ''; // Track actual filename during chunked streaming
  let forceUIUpdate = 0; // Force reactivity trigger
  
  // Debug options
  let debugSaveChunks = false; // Debug option to save chunks to temp folder
  
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
    
    // Check file type and warn about potential issues
    const fileExt = file.name.split('.').pop().toLowerCase();
    const audioFormats = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'webm'];
    const videoFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
    
    let warning = '';
    let icon = 'mdi:file-music';
    
    if (videoFormats.includes(fileExt)) {
      warning = '⚠️ Video file detected. Audio will be extracted for transcription.';
      icon = 'mdi:file-video';
    } else if (!audioFormats.includes(fileExt)) {
      warning = '⚠️ Unusual file format. Transcription may fail.';
      icon = 'mdi:file-question';
    }
      
    uploadAreaContent = {
      icon: icon,
      title: file.name,
      subtitle: `Ready to ${mode} transcribe (${formatBytes(file.size)})`,
      description: warning || description
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
      const newFile = files[0];
      selectedFile = newFile; // Set selectedFile first
      updateUploadAreaWithFile(newFile); // Then update UI
    }
  }
  
  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      const newFile = files[0];
      selectedFile = newFile; // Set selectedFile first
      updateUploadAreaWithFile(newFile); // Then update UI
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
  
  // Update upload area when chunked mode changes or file selection changes
  $: if (selectedFile) {
    updateUploadAreaWithFile(selectedFile);
  }
  
  // Also update when chunked streaming mode toggles
  $: if (selectedFile && $chunkedStreamingMode !== undefined) {
    updateUploadAreaWithFile(selectedFile);
  }
  
  // Debug reactive updates
  $: if ($chunkedUploadedChunks || $chunkedProgress || forceUIUpdate) {
    console.log('🔄 UI Reactive update triggered:', {
      uploadedChunks: $chunkedUploadedChunks,
      progress: $chunkedProgress,
      forceUIUpdate,
      timestamp: Date.now()
    });
  }
  
  // Reactive button text
  $: buttonText = (() => {
    if ($isStreaming || $isChunkedStreaming) {
      const filename = $isChunkedStreaming ? currentChunkedFilename : $currentStreamingFilename;
      const mode = $isChunkedStreaming ? 'Chunked Streaming' : 'Streaming';
      return `🔄 ${mode} ${filename}...`;
    }
    
    // Check if we have the required input based on source mode
    const hasInput = sourceMode === 'file' ? selectedFile : url.trim();
    
    if (hasInput) {
      return $chunkedStreamingMode ? 'Start Chunked Streaming' : 'Start Live Streaming';
    } else {
      return sourceMode === 'file' ? 'Select Audio File' : 'Enter Audio URL';
    }
  })();
  
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
      forceUIUpdate++; // Trigger reactivity every second
    }, 1000);
  }
  
  // Listen for manual progress updates
  if (typeof window !== 'undefined') {
    window.addEventListener('chunk-progress-update', (event) => {
      console.log('📊 Received progress update event:', event.detail);
      forceUIUpdate++; // Force reactivity
    });
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
    
    const options = {
      filename: sourceMode === 'file' ? selectedFile.name : url.split('/').pop() || 'audio',
      file: sourceMode === 'file' ? selectedFile : null,
      url: sourceMode === 'url' ? url : null,
      chunkSizeMB,
      useLLM: llmMode !== 'disabled',
      llmMode: llmMode, // Pass the selected LLM mode
      model,
      debugSaveChunks
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
      
      // Store the actual filename for display
      currentChunkedFilename = options.filename;
      
      // Set file size for display
      if (selectedFile) {
        $chunkedFileSize = formatBytes(selectedFile.size);
      } else if (result.job && result.job.file_size) {
        $chunkedFileSize = formatBytes(result.job.file_size);
      }
      
      // Initialize chunk slots
      initializeChunkSlots(result.chunk_info.total_chunks);
      
              // Set initial progress to show upload starting
        $chunkedProgress = { upload: 0, processing: 0, overall: 0 };
        $chunkedUploadedChunks = 0;
        $chunkedCompletedChunks = 0;
        $chunkedFailedChunks = 0;
        $chunkedSuccessRate = 0;
        
        console.log('🎬 Chunked streaming initialized with progress reset');
      
      startElapsedTimer();
      
      // Start SSE stream for real-time updates
      console.log('🌊 Starting SSE stream for job:', result.parent_job_id);
      chunkedEventSource = await createChunkedStreamEventSource(result.parent_job_id);
      
      chunkedEventSource.onopen = function(event) {
        console.log('✅ SSE connection opened:', event);
      };
      
      chunkedEventSource.onmessage = handleChunkedStreamEvent;
      chunkedEventSource.onerror = handleChunkedStreamError;
      
      // Add a timeout to check if SSE is working and send keepalive
      setTimeout(() => {
        if (chunkedEventSource && chunkedEventSource.readyState === EventSource.CONNECTING) {
          console.warn('⚠️ SSE connection still connecting after 5 seconds');
        } else if (chunkedEventSource && chunkedEventSource.readyState === EventSource.CLOSED) {
          console.warn('⚠️ SSE connection closed unexpectedly');
        } else {
          console.log('✅ SSE connection status:', chunkedEventSource?.readyState === EventSource.OPEN ? 'OPEN' : 'OTHER');
        }
      }, 5000);
      
      // Add periodic SSE health check
      const sseHealthCheck = setInterval(() => {
        if (!chunkedEventSource || chunkedEventSource.readyState === EventSource.CLOSED) {
          console.log('🔌 SSE connection lost, cleaning up health check');
          clearInterval(sseHealthCheck);
          return;
        }
        
        if (chunkedEventSource.readyState === EventSource.CONNECTING) {
          console.warn('⚠️ SSE still connecting...');
        } else if (chunkedEventSource.readyState === EventSource.OPEN) {
          console.log('💓 SSE connection healthy');
        }
      }, 10000); // Check every 10 seconds
      
      // Start uploading chunks if we have a file
      // Handle upload based on mode
      if (options.file) {
        // NEW: Check if server already processed the file (audio-aware chunking)
        if (result.message && result.message.includes('audio-aware processing')) {
          console.log('✅ Server-side audio-aware chunking completed, skipping client-side upload');
          console.log('📊 Chunking results:', {
            total_chunks: result.chunk_info.total_chunks,
            chunking_method: result.chunk_info.chunking_method,
            playable_chunks: result.chunk_info.playable_chunks
          });
          
          // File is already uploaded and chunked, processing should start automatically
          streamLogger.info('Audio-aware chunking completed on server', {
            total_chunks: result.chunk_info.total_chunks,
            chunking_method: result.chunk_info.chunking_method
          });
          
        } else if (result.upload_urls) {
          // LEGACY: Old client-side chunking mode (for URL uploads or fallback)
          console.log('⚠️ Using legacy client-side chunking mode');
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
          console.error('Unexpected response format - no upload URLs or processing confirmation');
          alert('Unexpected server response format');
          stopChunkedStreaming();
          return;
        }
      } else {
        console.log('URL upload - processing handled by server');
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
      console.log('🔄 SSE Event received:', event.data);
      const data = JSON.parse(event.data);
      console.log('📡 Parsed SSE data:', data);
      handleChunkedEvent(data);
    } catch (error) {
      console.error('Failed to parse chunked SSE data:', error, event.data);
    }
  }
  
  function handleChunkedStreamError(error) {
    console.log('❌ Chunked SSE error event:', error);
    console.log('🔌 SSE readyState:', chunkedEventSource?.readyState);
    console.log('🔄 Is still streaming?', $isChunkedStreaming);
    
    // Check if this is just a normal stream closure after completion
    if (chunkedEventSource && chunkedEventSource.readyState === EventSource.CLOSED) {
      // Stream closed normally after completion - this is expected
      streamLogger.info('Chunked stream closed after completion', { 
        readyState: chunkedEventSource.readyState 
      });
      
      // Only log as error if we're still expecting the stream to be active
      if ($isChunkedStreaming) {
        streamLogger.warn('Chunked stream closed unexpectedly while still processing');
        console.warn('⚠️ Stream closed but still expecting updates - this might indicate a connection issue');
      }
      
      return;
    }
    
    // This is an actual error
    streamLogger.error('Chunked stream error', error);
    console.error('❌ Chunked SSE error:', error);
    
    // Only show user-facing error if we're still actively streaming
    if ($isChunkedStreaming) {
      console.error('💥 Stream connection lost during active streaming');
      // Don't show alert immediately, wait a bit to see if it recovers
      setTimeout(() => {
        if ($isChunkedStreaming && (!chunkedEventSource || chunkedEventSource.readyState === EventSource.CLOSED)) {
          alert('Stream connection lost. Check console for details. The upload may still be processing.');
        }
      }, 5000);
    }
  }
  
  async function handleChunkedEvent(data) {
    console.log('🎯 Processing SSE event:', data.type, data);
    
    switch (data.type) {
      case 'initialized':
        $chunkedTotalChunks = data.total_chunks;
        streamLogger.info('Chunked upload initialized', { 
          parent_job_id: data.parent_job_id,
          total_chunks: data.total_chunks
        });
        
        // Update file size if server provides actual size (for URL uploads)
        if (data.total_size && data.total_size > 0 && !$chunkedFileSize) {
          $chunkedFileSize = formatBytes(data.total_size);
        }
        break;
        
      case 'progress_update':
        console.log('📊 SSE Progress update received:', {
          upload: data.upload_progress,
          processing: data.processing_progress,
          overall: data.progress,
          uploaded_chunks: data.uploaded_chunks,
          completed_chunks: data.completed_chunks
        });
        
        // Get current values for comparison
        const currentProgress = get(chunkedProgress);
        const currentUploaded = $chunkedUploadedChunks;
        
        console.log('📊 Current vs SSE progress:', {
          current: {
            upload: currentProgress.upload,
            processing: currentProgress.processing,
            overall: currentProgress.overall,
            uploaded_chunks: currentUploaded
          },
          sse: {
            upload: data.upload_progress,
            processing: data.processing_progress,
            overall: data.progress,
            uploaded_chunks: data.uploaded_chunks
          }
        });
        
        // Only update if SSE has valid data (not 0 or undefined)
        // and is reasonably higher than current (allow some fluctuation)
        const newUploadProgress = (data.upload_progress || 0) > 0 ? 
          Math.max(currentProgress.upload || 0, data.upload_progress) : 
          currentProgress.upload || 0;
          
        const newProcessingProgress = (data.processing_progress || 0) > 0 ? 
          Math.max(currentProgress.processing || 0, data.processing_progress) : 
          currentProgress.processing || 0;
          
        const newOverallProgress = (data.progress || 0) > 0 ? 
          Math.max(currentProgress.overall || 0, data.progress) : 
          currentProgress.overall || 0;
          
        const newUploadedChunks = (data.uploaded_chunks || 0) >= 0 ? 
          Math.max(currentUploaded || 0, data.uploaded_chunks) : 
          currentUploaded || 0;
        
        // Only update if there's actually a meaningful change
        const hasSignificantChange = 
          Math.abs(newUploadProgress - (currentProgress.upload || 0)) > 0 ||
          Math.abs(newProcessingProgress - (currentProgress.processing || 0)) > 0 ||
          Math.abs(newOverallProgress - (currentProgress.overall || 0)) > 0 ||
          Math.abs(newUploadedChunks - (currentUploaded || 0)) > 0;
        
        if (hasSignificantChange) {
          console.log('📊 Updating progress stores:', {
            from: currentProgress,
            to: { upload: newUploadProgress, processing: newProcessingProgress, overall: newOverallProgress },
            uploadedChunks: { from: currentUploaded, to: newUploadedChunks }
          });
          
          $chunkedProgress = {
            upload: newUploadProgress,
            processing: newProcessingProgress,
            overall: newOverallProgress
          };
          $chunkedUploadedChunks = newUploadedChunks;
          $chunkedCompletedChunks = data.completed_chunks || $chunkedCompletedChunks;
          $chunkedFailedChunks = data.failed_chunks || $chunkedFailedChunks;
          $chunkedSuccessRate = data.success_rate || $chunkedSuccessRate;
        } else {
          console.log('📊 Skipping SSE progress update - no significant change detected');
        }
        break;
        
      case 'chunk_complete':
        console.log('🎯 Chunk completed:', data);
        
        // Update chunk slot
        updateChunkSlot(data.chunk_index, {
          status: 'complete',
          text: data.text || data.transcript,
          rawText: data.raw_text || data.text || data.transcript,
          correctedText: data.corrected_text,
          llmApplied: data.llm_applied || false,
          processingTime: data.processing_time || 0,
          completedAt: new Date().toISOString(),
          arrivalOrder: ($chunkedCompletedChunks || 0) + 1 // Track arrival order for speed mode
        });
        
        // Update counters
        $chunkedCompletedChunks = ($chunkedCompletedChunks || 0) + 1;
        
        updateProgress();
        updateReadableTranscript();
        break;
        
      case 'chunk_skipped':
        console.log('⏭️ Chunk skipped:', data);
        
        // Handle skipped chunks (usually chunk 0 with metadata)
        updateChunkSlot(data.chunk_index, {
          status: 'skipped',
          text: '',
          rawText: '',
          correctedText: '',
          llmApplied: false,
          processingTime: 0,
          completedAt: new Date().toISOString(),
          skipReason: data.reason,
          arrivalOrder: ($chunkedCompletedChunks || 0) + 1
        });
        
        // Count skipped chunks as completed for progress purposes
        $chunkedCompletedChunks = ($chunkedCompletedChunks || 0) + 1;
        
        // Show user-friendly notification for chunk 0
        if (data.chunk_index === 0) {
          console.log('📋 Chunk 0 skipped: This is normal for files with metadata/headers');
          // You could add a toast notification here if desired
        }
        
        updateProgress();
        updateReadableTranscript();
        break;
        
      case 'chunk_failed':
        console.error('❌ Chunk failure received:', {
          chunk_index: data.chunk_index,
          error: data.error
        });
        
        updateChunkSlot(data.chunk_index, {
          status: 'failed',
          error: data.error
        });
        break;
        
      case 'partial_transcript':
        $chunkedReadableTranscript = data.partial_transcript;
        break;
        
      case 'final_result':
        console.log('🏁 Final result received:', {
          success_rate: data.success_rate,
          transcript_length: data.final_transcript?.length || 0,
          failed_chunks: data.failed_chunks,
          successful_chunks: data.successful_chunks
        });
        
        // Check if transcription actually succeeded
        if (!data.final_transcript || data.final_transcript.trim() === '') {
          console.error('❌ Final result has empty transcript!');
          alert('Transcription completed but no text was generated. This may be due to audio format issues or silent audio.');
        }
        
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
        setTimeout(async () => {
          try {
            await fetchJobs();
            streamLogger.info('Jobs refreshed after chunked streaming completion');
          } catch (refreshError) {
            streamLogger.error('Failed to refresh jobs after chunked streaming', refreshError);
          }
        }, 1000); // Single refresh after 1 second
        
        // Set show results flag and clean up streaming state
        $showChunkedStreamingResults = true;
        $isChunkedStreaming = false;
        
        // Clear filename tracking
        currentChunkedFilename = '';
        
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
        
        // Reset form state after a brief delay, but preserve selected file
        setTimeout(() => {
          if (sourceMode === 'url') {
            url = '';
          }
          // Don't reset upload area immediately - let user keep the file selected
        }, 2000);
        break;
        
      case 'job_terminated':
        console.error('💀 Job terminated:', {
          reason: data.reason,
          status: data.status,
          partial_results: data.partial_results
        });
        
        streamLogger.error('Chunked job terminated', { 
          reason: data.reason,
          status: data.status 
        });
        
        if (data.reason && data.reason.includes('No valid chunks')) {
          alert('Transcription failed: No valid audio chunks found. This may be due to:\n• Unsupported audio format\n• Silent or corrupted audio\n• Audio encoding issues\n\nTry converting to MP3 or WAV format.');
        }
        
        stopChunkedStreaming();
        break;
        
      case 'stream_error':
        console.error('🚨 Stream error received:', data);
        if (data.error && data.error.includes('No valid chunks')) {
          alert('Stream error: No valid chunks found for transcription. Check the console for details.');
        }
        break;
        
      default:
        console.log('🤷 Unknown SSE event type:', data.type, data);
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
    
    // Clear filename tracking
    currentChunkedFilename = '';
    
    // Reset form state after a brief delay, but preserve selected file
    setTimeout(() => {
      if (sourceMode === 'url') {
        url = '';
      }
      // Don't reset upload area immediately - let user keep the file selected
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
      formData.append('model', selectedModel);
      
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
        chunk_size_mb: chunkSizeMB,
        model: selectedModel
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
            
            // Refresh jobs list after streaming completion
            setTimeout(async () => {
              try {
                await fetchJobs();
                streamLogger.info('Jobs refreshed after streaming completion');
              } catch (refreshError) {
                streamLogger.error('Failed to refresh jobs after streaming', refreshError);
              }
            }, 1000); // Single refresh after 1 second
            
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
    
    // Reset form state after a brief delay, but preserve selected file
    setTimeout(() => {
      if (sourceMode === 'url') {
        url = '';
      }
      // Don't reset upload area immediately - let user keep the file selected
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
      <div>
        <label for="model-select-streaming" class="text-terminal-text-dim block mb-1">Whisper model:</label>
        <select 
          id="model-select-streaming"
          bind:value={selectedModel}
          disabled={$isStreaming || $isChunkedStreaming}
          class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent"
          class:opacity-50={$isStreaming || $isChunkedStreaming}
        >
          {#each whisperModels as model}
            <option value={model.value}>{model.label}</option>
          {/each}
        </select>
        <div class="text-xs text-terminal-text-dim mt-1">
          💡 <strong>Turbo:</strong> Faster processing, <strong>v3:</strong> Higher accuracy
        </div>
      </div>
      
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
          <div class="text-xs text-terminal-text-dim mt-1">
            💡 <strong>Tip:</strong> Files with lots of metadata (album art, tags) benefit from larger chunks (10MB+) to ensure the first chunk contains enough audio for transcription.
          </div>
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

      <div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" bind:checked={debugSaveChunks} class="w-4 h-4">
          <iconify-icon icon="mdi:brain" class="text-terminal-accent"></iconify-icon>
          <span class="text-terminal-accent">LLM Error Correction</span>
          <span class="text-terminal-text-dim">(Improves accuracy)</span>
        </label>
      </div>

      <!-- Debug Options -->
      <div class="border border-terminal-border p-2">
        <div class="text-terminal-text font-bold mb-2 text-sm">🐛 Debug Options</div>
        <div>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" bind:checked={debugSaveChunks} class="w-4 h-4">
            <iconify-icon icon="mdi:folder-download" class="text-terminal-text-dim"></iconify-icon>
            <span class="text-terminal-text">Save chunks to debug storage</span>
            <span class="text-terminal-text-dim text-xs">(For troubleshooting chunk issues)</span>
          </label>
          {#if debugSaveChunks}
            <div class="text-xs text-terminal-text-dim mt-1 ml-6">
              ⚠️ Chunks will be saved to R2 debug storage for inspection. 
              Check logs for full R2 URLs to access files directly.
            </div>
          {/if}
        </div>
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
      {buttonText}
    {/if}
  </button>
</div>

 