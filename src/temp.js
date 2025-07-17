// Minimal Svelte-like implementation for the web interface
const API_BASE = '';

// Component state
let jobs = [];
let selectedJob = null;
let showCompleted = false;
let isUploading = false;
let isStreaming = false;
let streamingTranscript = '';
let streamingProgress = 0;

// Initialize the app
function init() {
  createApp();
  fetchJobs();
  setInterval(fetchJobs, 3000);
}

function createApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <main class="max-w-6xl mx-auto p-5">
      <!-- CLI Header -->
      <div class="border border-terminal-border bg-terminal-bg-light p-4 mb-4">
        <div class="flex items-center gap-2 text-lg font-bold">
          <span>⚡</span>
          <span class="text-terminal-accent">Groq Whisper XL CLI</span>
        </div>
        <div class="text-terminal-text-dim mt-1">
          Universal Audio Transcription Tool
        </div>
        
        <div class="mt-4">
          <div class="flex items-center gap-2">
            <span class="text-terminal-accent">⚡ Status:</span>
            <span class="text-status-success">ONLINE</span>
            <span class="text-terminal-text-dim">- Ready for transcription</span>
          </div>
          
          <div class="ml-6 mt-2 space-y-0.5">
            <div class="text-terminal-text-dim">• 🚀 Ultra-fast transcription using Groq's Whisper API</div>
            <div class="text-terminal-text-dim">• 📁 Universal file support (MP3 to 100GB+)</div>
            <div class="text-terminal-text-dim">• 🎯 Smart tier detection (Standard/Advanced/Enterprise)</div>
            <div class="text-terminal-text-dim">• 🧠 LLM error correction for improved accuracy</div>
            <div class="text-terminal-text-dim">• 🌐 URL-based audio processing</div>
            <div class="text-terminal-text-dim">• 📊 Real-time progress tracking</div>
            <div class="text-terminal-text-dim">• 🌊 Streaming transcription with live results</div>
          </div>
          
          <div class="pt-2 border-t border-terminal-border mt-4">
            <div class="text-terminal-text-dim">Current endpoint: ${window.location.origin}</div>
            <div class="flex items-center gap-2 mt-1">
              <span class="w-2 h-2 bg-status-success rounded-full animate-pulse-slow"></span>
              <span class="text-status-success">Status: ONLINE</span>
              <span class="text-terminal-text-dim">- Ready for transcription</span>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Upload Section -->
      <div class="border border-terminal-border bg-terminal-bg-light p-4 mb-4">
        <div class="font-bold text-center mb-4 border-b border-terminal-border pb-2">Main Menu</div>
        
        <div class="font-bold mb-2">Upload Methods:</div>
        
        <!-- File Upload -->
        <div class="border border-terminal-border p-3 mb-4">
          <div class="flex items-center gap-2 mb-3 font-bold">
            <span>📁</span>
            <span>1. 📁 Direct Upload (Recommended)</span>
          </div>
          
          <div id="upload-area" class="border-2 border-dashed border-terminal-border p-8 text-center cursor-pointer transition-all hover:border-terminal-accent hover:bg-gray-900/20">
            <div>📁</div>
            <div class="font-bold">Drop audio files here or click to browse</div>
            <div class="text-xs text-terminal-text-dim">Supports: MP3, WAV, M4A, FLAC, etc. (up to 1GB)</div>
          </div>
          
          <input type="file" id="file-input" accept="audio/*,video/*" class="hidden">
        </div>
        
        <!-- URL Upload -->
        <div class="border border-terminal-border p-3 mb-4">
          <div class="flex items-center gap-2 mb-3 font-bold">
            <span>🌐</span>
            <span>2. 🌐 URL Upload (From web)</span>
          </div>
          
          <div class="flex gap-2">
            <input id="url-input" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 flex-1 focus:outline-none focus:border-terminal-accent" type="url" placeholder="https://example.com/audio.mp3">
            <button id="url-upload-btn" class="bg-terminal-accent text-terminal-bg px-4 py-2 hover:bg-gray-300 transition-colors">Upload</button>
          </div>
        </div>
        
        <!-- Streaming Upload -->
        <div class="border border-terminal-border p-3 mb-4">
          <div class="flex items-center gap-2 mb-3 font-bold">
            <span>🌊</span>
            <span>3. 🌊 Streaming Upload (Real-time results)</span>
          </div>
          
          <div class="text-xs text-terminal-text-dim mb-3">
            📖 Processes audio in tiny chunks and streams results in real-time<br>
            💡 Perfect for testing the streaming API or getting incremental results
          </div>
          
          <!-- Streaming file/URL selection -->
          <div class="flex gap-2 mb-3">
            <button id="stream-file-btn" class="bg-terminal-bg border border-terminal-border text-terminal-text px-4 py-2 hover:bg-gray-700 transition-colors flex-1">📁 Stream File</button>
            <button id="stream-url-btn" class="bg-terminal-bg border border-terminal-border text-terminal-text px-4 py-2 hover:bg-gray-700 transition-colors flex-1">🌐 Stream URL</button>
          </div>
          
          <!-- Stream URL input (hidden by default) -->
          <div id="stream-url-section" class="hidden mb-3">
            <input id="stream-url-input" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent" type="url" placeholder="https://example.com/audio.mp3">
          </div>
          
          <!-- Streaming settings -->
          <div id="streaming-settings" class="border border-terminal-border p-3 bg-terminal-bg mb-3">
            <div class="font-bold mb-3 border-b border-terminal-border pb-1">Streaming Settings:</div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="text-terminal-text-dim block mb-1">Chunk size (MB):</label>
                <select id="chunk-size" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent">
                  <option value="0.25">0.25MB (Ultra-fast, real-time)</option>
                  <option value="0.5">0.5MB (Fast)</option>
                  <option value="1" selected>1MB (Balanced)</option>
                  <option value="2">2MB (Slower, fewer API calls)</option>
                </select>
                <div class="text-xs text-terminal-text-dim mt-1">Smaller chunks = faster streaming, more API calls</div>
              </div>
              
              <div>
                <label class="text-terminal-text-dim block mb-1">LLM Mode:</label>
                <select id="llm-mode" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent">
                  <option value="disabled">Disabled (fastest)</option>
                  <option value="per_chunk" selected>Per-chunk (real-time correction)</option>
                  <option value="post_process">Post-process (full context)</option>
                </select>
                <div class="text-xs text-terminal-text-dim mt-1">Per-chunk: live corrections, Post-process: better quality</div>
              </div>
            </div>
          </div>
          
          <button id="start-stream-btn" class="bg-status-info text-terminal-bg px-4 py-2 hover:bg-blue-600 transition-colors w-full font-bold">🚀 Start Streaming</button>
          <input type="file" id="stream-file-input" accept="audio/*,video/*" class="hidden">
        </div>
        
        <!-- Settings -->
        <div class="border border-terminal-border p-3 bg-terminal-bg">
          <div class="font-bold mb-3 border-b border-terminal-border pb-1">Settings:</div>
          
          <div class="my-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" id="use-llm">
              <span class="text-terminal-accent">🧠 LLM Error Correction</span>
              <span class="text-terminal-text-dim">(Improves accuracy)</span>
            </label>
          </div>
          
          <div class="my-2">
            <label class="text-terminal-text-dim">Webhook URL (optional):</label>
            <input id="webhook-url" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent" type="url" placeholder="https://your-webhook.com/endpoint">
          </div>
        </div>
      </div>
      
      <!-- Streaming Display Section -->
      <div id="streaming-display" class="border border-terminal-border bg-terminal-bg-light p-4 mb-4 hidden">
        <div class="font-bold text-center mb-4 border-b border-terminal-border pb-2">🌊 Live Streaming Transcription</div>
        
        <!-- Streaming Status -->
        <div id="streaming-status" class="mb-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="w-2 h-2 bg-status-info rounded-full animate-pulse-slow"></span>
            <span class="font-bold text-status-info">Streaming in progress...</span>
            <span id="streaming-filename" class="text-terminal-text-dim"></span>
          </div>
          
          <!-- Progress bar -->
          <div class="bg-terminal-bg border border-terminal-border h-5 overflow-hidden">
            <div id="streaming-progress-bar" class="bg-status-info h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" style="width: 0%;">0%</div>
          </div>
          
          <div id="streaming-info" class="text-xs text-terminal-text-dim mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
            <span>Chunks: <span id="chunks-processed">0</span>/<span id="total-chunks">?</span></span>
            <span>Size: <span id="file-size">-</span></span>
            <span>Elapsed: <span id="elapsed-time">0s</span></span>
            <span>Mode: <span id="stream-mode">-</span></span>
          </div>
        </div>
        
        <!-- Live Transcript -->
        <div class="border border-terminal-border bg-terminal-bg">
          <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent">📝 Live Transcript:</div>
          <div id="streaming-transcript" class="p-4 max-h-96 overflow-y-auto font-mono text-sm leading-relaxed">
            <div class="text-terminal-text-dim italic">Waiting for transcription results...</div>
          </div>
        </div>
        
        <!-- Stop button -->
        <div class="mt-4 text-center">
          <button id="stop-stream-btn" class="bg-status-error text-terminal-bg px-6 py-2 hover:bg-red-600 transition-colors font-bold">🛑 Stop Streaming</button>
        </div>
      </div>
      
      <!-- Jobs Section -->
      <div>
        <h2 class="text-lg mb-4">Job Management:</h2>
        
        <div id="running-jobs" class="mb-6"></div>
        
        <div>
          <div id="completed-toggle" class="cursor-pointer flex items-center gap-2 py-2 border-b border-terminal-border">
            <span id="toggle-icon" class="transition-transform duration-300">▶</span>
            <span class="font-bold text-status-success">✅ Completed Jobs (<span id="completed-count">0</span>)</span>
          </div>
          
          <div id="completed-jobs" class="max-h-0 overflow-hidden transition-all duration-300"></div>
        </div>
      </div>
      
      <!-- Audio Player Section -->
      <div id="audio-player" class="mt-4 hidden"></div>
      
      <!-- Footer -->
      <div class="border border-terminal-border mt-4 p-3 bg-terminal-bg-light text-center">
        <div class="text-xs">
          <span class="text-terminal-text-dim">Choose an option (0-11): </span>
          <span class="text-terminal-accent">* History restored</span>
        </div>
      </div>
    </main>
  `;
  
  setupEventListeners();
}

function setupEventListeners() {
  // File upload
  const uploadArea = document.getElementById('upload-area');
  const fileInput = document.getElementById('file-input');
  
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('border-terminal-accent', 'bg-green-900/20');
    uploadArea.classList.remove('border-terminal-border');
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('border-terminal-accent', 'bg-green-900/20');
    uploadArea.classList.add('border-terminal-border');
  });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('border-terminal-accent', 'bg-green-900/20');
    uploadArea.classList.add('border-terminal-border');
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  });
  
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  });
  
  // URL upload
  document.getElementById('url-upload-btn').addEventListener('click', uploadFromUrl);
  
  // Streaming controls
  document.getElementById('stream-file-btn').addEventListener('click', () => {
    document.getElementById('stream-file-input').click();
  });
  
  document.getElementById('stream-url-btn').addEventListener('click', () => {
    const urlSection = document.getElementById('stream-url-section');
    urlSection.classList.toggle('hidden');
    if (!urlSection.classList.contains('hidden')) {
      document.getElementById('stream-url-input').focus();
    }
  });
  
  document.getElementById('stream-file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      startFileStreaming(files[0]);
    }
  });
  
  document.getElementById('start-stream-btn').addEventListener('click', () => {
    const urlInput = document.getElementById('stream-url-input');
    if (!urlInput.classList.contains('hidden') && urlInput.value.trim()) {
      startUrlStreaming(urlInput.value.trim());
    }
  });
  
  document.getElementById('stop-stream-btn').addEventListener('click', stopStreaming);
  
  // Completed jobs toggle
  document.getElementById('completed-toggle').addEventListener('click', () => {
    showCompleted = !showCompleted;
    const icon = document.getElementById('toggle-icon');
    const container = document.getElementById('completed-jobs');
    
    if (showCompleted) {
      icon.textContent = '▼';
      icon.classList.add('rotate-90');
      container.classList.remove('max-h-0');
      container.classList.add('max-h-96');
      updateJobsList();
    } else {
      icon.textContent = '▶';
      icon.classList.remove('rotate-90');
      container.classList.add('max-h-0');
      container.classList.remove('max-h-96');
    }
  });
}

// Streaming functionality
let streamController = null;
let streamStartTime = Date.now();

async function startFileStreaming(file) {
  if (isStreaming) return;
  
  const chunkSize = parseFloat(document.getElementById('chunk-size').value);
  const llmMode = document.getElementById('llm-mode').value;
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('chunk_size_mb', chunkSize.toString());
  
  if (llmMode !== 'disabled') {
    formData.append('use_llm', 'true');
    formData.append('llm_mode', llmMode);
  } else {
    formData.append('use_llm', 'false');
  }
  
  await startStreaming('/stream', {
    method: 'POST',
    body: formData
  }, file.name);
}

async function startUrlStreaming(url) {
  if (isStreaming) return;
  
  const chunkSize = parseFloat(document.getElementById('chunk-size').value);
  const llmMode = document.getElementById('llm-mode').value;
  
  const payload = {
    url: url,
    chunk_size_mb: chunkSize
  };
  
  if (llmMode !== 'disabled') {
    payload.use_llm = true;
    payload.llm_mode = llmMode;
  } else {
    payload.use_llm = false;
  }
  
  await startStreaming('/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, url.split('/').pop() || 'audio.mp3');
}

async function startStreaming(endpoint, requestOptions, filename) {
  if (isStreaming) return;
  
  isStreaming = true;
  streamingTranscript = '';
  streamingProgress = 0;
  streamStartTime = Date.now();
  
  // Show streaming display
  document.getElementById('streaming-display').classList.remove('hidden');
  document.getElementById('streaming-filename').textContent = filename;
  document.getElementById('stream-mode').textContent = document.getElementById('llm-mode').value;
  
  // Reset display
  document.getElementById('streaming-transcript').innerHTML = '<div class="text-terminal-text-dim italic">Starting transcription...</div>';
  document.getElementById('streaming-progress-bar').style.width = '0%';
  document.getElementById('streaming-progress-bar').textContent = '0%';
  
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
      
      if (done || !isStreaming) {
        break;
      }
      
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      
      const lines = buffer.split('
');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            handleStreamEvent(data);
          } catch (error) {
            console.warn('Failed to parse stream data:', error);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Streaming error:', error);
    displayStreamError(error.message);
  } finally {
    if (isStreaming) {
      stopStreaming();
    }
  }
}

function handleStreamEvent(data) {
  const { type } = data;
  
  switch (type) {
    case 'status':
      document.getElementById('file-size').textContent = formatBytes(data.total_size);
      document.getElementById('total-chunks').textContent = data.estimated_chunks;
      updateStreamingTranscript('📋 Starting transcription of ' + data.filename + ' (' + formatBytes(data.total_size) + ')...
');
      break;
      
    case 'chunk_info':
      document.getElementById('total-chunks').textContent = data.total_chunks;
      updateStreamingTranscript('🧩 Ready to process ' + data.total_chunks + ' chunks (' + data.chunk_size_mb + 'MB each)

');
      break;
      
    case 'chunk_start':
      updateProgress(data.progress);
      updateStreamingTranscript('🔄 Chunk ' + (data.chunk_index + 1) + ' (' + data.progress + '%) - transcribing...
');
      break;
      
    case 'delta':
      if (data.llm_applied) {
        updateStreamingTranscript('📝 Raw: "' + data.raw_text + '"
');
        updateStreamingTranscript('🧠 LLM: "' + data.corrected_text + '"

');
      } else if (data.llm_error) {
        updateStreamingTranscript('📝 "' + data.raw_text + '"
');
        updateStreamingTranscript('⚠️  LLM failed: ' + data.llm_error + '

');
      } else {
        const text = data.text || data.raw_text;
        updateStreamingTranscript('📝 "' + text + '"

');
      }
      
      // Update chunks processed counter
      const chunksProcessed = parseInt(document.getElementById('chunks-processed').textContent) + 1;
      document.getElementById('chunks-processed').textContent = chunksProcessed;
      break;
      
    case 'chunk_done':
      updateProgress(data.progress);
      updateStreamingTranscript('✅ Chunk ' + (data.chunk_index + 1) + ' completed (' + data.progress + '%)

');
      break;
      
    case 'chunk_error':
      updateStreamingTranscript('❌ Chunk ' + (data.chunk_index + 1) + ' error: ' + data.error + '

');
      break;
      
    case 'llm_processing':
      const mode = data.mode === 'post_process' ? 'post-processing' : 'per-chunk';
      updateStreamingTranscript('🧠 ' + (data.message || ('Applying LLM corrections (' + mode + ')...')) + '
');
      break;
      
    case 'llm_done':
      const doneMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
      updateStreamingTranscript('✅ ' + doneMode + ' LLM correction completed
');
      if (data.mode === 'post_process') {
        updateStreamingTranscript('📝 Improved transcript:
"' + data.corrected_text + '"

');
      }
      break;
      
    case 'llm_error':
      const errorMode = data.mode === 'post_process' ? 'Post-processing' : 'Per-chunk';
      updateStreamingTranscript('❌ ' + errorMode + ' LLM correction failed: ' + data.error + '
');
      if (data.fallback_text) {
        updateStreamingTranscript('📝 Using original transcript: "' + data.fallback_text + '"

');
      }
      break;
      
    case 'done':
      updateProgress(100);
      updateStreamingTranscript('
🎉 Transcription completed!
');
      updateStreamingTranscript('📊 Total segments: ' + data.total_segments + '

');
      
      if (data.llm_correction_applied && data.corrected_transcript) {
        updateStreamingTranscript('📝 Raw transcript:
"' + data.raw_transcript + '"

');
        updateStreamingTranscript('🧠 LLM-corrected transcript:
"' + data.corrected_transcript + '"

');
      } else {
        updateStreamingTranscript('📝 Final transcript:
"' + data.final_transcript + '"

');
      }
      
      // Show save option
      updateStreamingTranscript('💾 Transcript ready for download!
');
      setTimeout(() => stopStreaming(), 2000);
      break;
      
    case 'error':
      displayStreamError(data.error);
      break;
  }
  
  // Update elapsed time
  const elapsed = Math.round((Date.now() - streamStartTime) / 1000);
  document.getElementById('elapsed-time').textContent = elapsed + 's';
}

function updateProgress(progress) {
  streamingProgress = progress;
  const progressBar = document.getElementById('streaming-progress-bar');
  progressBar.style.width = progress + '%';
  progressBar.textContent = progress + '%';
}

function updateStreamingTranscript(text) {
  streamingTranscript += text;
  const transcriptDiv = document.getElementById('streaming-transcript');
  transcriptDiv.innerHTML = streamingTranscript.replace(/
/g, '<br>');
  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function displayStreamError(error) {
  updateStreamingTranscript('
❌ Stream error: ' + error + '
');
  setTimeout(() => stopStreaming(), 3000);
}

function stopStreaming() {
  isStreaming = false;
  
  // Hide streaming display
  setTimeout(() => {
    document.getElementById('streaming-display').classList.add('hidden');
    
    // Reset state
    streamingTranscript = '';
    streamingProgress = 0;
    document.getElementById('chunks-processed').textContent = '0';
    document.getElementById('total-chunks').textContent = '?';
    document.getElementById('file-size').textContent = '-';
    document.getElementById('elapsed-time').textContent = '0s';
    
    // Reset form
    document.getElementById('stream-file-input').value = '';
    document.getElementById('stream-url-input').value = '';
    document.getElementById('stream-url-section').classList.add('hidden');
  }, 2000);
}

async function fetchJobs() {
  try {
    const response = await fetch(API_BASE + '/jobs');
    if (response.ok) {
      const data = await response.json();
      jobs = data.jobs || [];
      updateJobsList();
    }
  } catch (error) {
    console.error('Failed to fetch jobs:', error);
  }
}

function updateJobsList() {
  const runningJobs = jobs.filter(job => 
    job.status === 'processing' || 
    job.status === 'uploaded' || 
    job.status === 'awaiting_upload'
  );
  
  const completedJobs = jobs.filter(job => 
    job.status === 'done' || 
    job.status === 'failed'
  );
  
  // Update running jobs
  const runningContainer = document.getElementById('running-jobs');
  if (runningJobs.length > 0) {
    const runningJobsHtml = runningJobs.map(job => createJobItem(job)).join('');
    runningContainer.innerHTML = 
      '<div class="font-bold mb-2 text-status-warning">' +
        '🔄 Running Jobs (' + runningJobs.length + ')' +
      '</div>' +
      '<div class="max-h-96 overflow-y-auto border border-terminal-border">' +
        runningJobsHtml +
      '</div>';
  } else {
    runningContainer.innerHTML = '';
  }
  // Update completed jobs count
  document.getElementById('completed-count').textContent = completedJobs.length;
  
  // Update completed jobs if expanded
  if (showCompleted) {
    const completedContainer = document.getElementById('completed-jobs');
    if (completedJobs.length > 0) {
      const completedJobsHtml = completedJobs.map(job => createJobItem(job)).join('');
      completedContainer.innerHTML = 
        '<div class="max-h-96 overflow-y-auto border border-terminal-border">' +
          completedJobsHtml +
        '</div>';
    } else {
      completedContainer.innerHTML = 
        '<div class="py-10 px-5 text-center text-terminal-text-dim">' +
          'No completed jobs' +
        '</div>';
    }
  }
}

function createJobItem(job) {
  const statusColors = {
    processing: 'bg-status-info text-terminal-bg',
    uploaded: 'bg-status-info text-terminal-bg',
    done: 'bg-status-success text-terminal-bg',
    failed: 'bg-status-error text-terminal-bg'
  };
  const statusClass = statusColors[job.status] || 'bg-status-warning text-terminal-bg';
  
  const statusIcon = {
    processing: '🔄',
    uploaded: '🔄',
    done: '✅',
    failed: '❌'
  }[job.status] || '⏳';
  
  return '<div class="border-b border-terminal-border p-3 hover:bg-gray-800/50 transition-colors">' +
    '<div class="flex justify-between items-start gap-3">' +
      '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-2 mb-1">' +
          '<span>📄</span>' +
          '<span class="font-bold">' + (job.filename || 'Unknown') + '</span>' +
          (job.source_url ? '<span class="text-status-info text-xs">from URL</span>' : '') +
        '</div>' +
        '<div class="flex flex-wrap gap-3 text-xs text-terminal-text-dim">' +
          '<span>ID: ' + job.job_id.slice(0, 8) + '...</span>' +
          '<span>' + formatBytes(job.file_size || 0) + '</span>' +
          '<span>' + (job.processing_method || 'direct') + '</span>' +
        '</div>' +
      '</div>' +
      
      '<div class="flex flex-col items-end gap-2">' +
        '<div class="px-2 py-1 text-xs font-bold uppercase ' + statusClass + '">' +
          statusIcon + ' ' + job.status +
        '</div>' +
        '<div class="flex gap-1">' +
          (job.status === 'done' ? '<button onclick="window.viewTranscript('' + job.job_id + '')" class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-2 py-1 text-xs hover:bg-gray-700 transition-colors">▶ View</button>' : '') +
          '<button onclick="window.deleteJob('' + job.job_id + '')" class="bg-status-error text-terminal-bg px-2 py-1 text-xs hover:bg-red-600 transition-colors">🗑 Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    
    (job.progress !== undefined && job.status === 'processing' ? '<div class="bg-terminal-bg border border-terminal-border h-5 overflow-hidden mt-2">' +
        '<div class="bg-terminal-accent h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" style="width: ' + (job.progress || 0) + '%;">' + (job.progress || 0) + '%</div>' +
      '</div>' : '') +
    
    '<div class="mt-2 flex flex-wrap gap-3 text-xs text-terminal-text-dim">' +
      '<span>⏰ Created: ' + new Date(job.created_at).toLocaleString() + '</span>' +
      (job.use_llm ? '<span class="text-terminal-accent">🧠 LLM Enhanced</span>' : '') +
      (job.error ? '<span class="text-status-error">❌ Error: ' + job.error + '</span>' : '') +
    '</div>' +
  '</div>';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function uploadFile(file) {
  if (isUploading || isStreaming) return;
  
  isUploading = true;
  const uploadArea = document.getElementById('upload-area');
  const originalContent = uploadArea.innerHTML;
  uploadArea.innerHTML = '<div>🔄 Uploading...</div>';
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('use_llm', document.getElementById('use-llm').checked.toString());
    
    const webhookUrl = document.getElementById('webhook-url').value;
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
      jobs.unshift({
        job_id: result.job_id,
        filename: result.filename,
        status: 'processing',
        file_size: result.file_size,
        processing_method: result.processing_method,
        created_at: new Date().toISOString()
      });
      updateJobsList();
      
      // Reset form
      document.getElementById('file-input').value = '';
    } else {
      const error = await response.json();
      alert('Upload failed: ' + (error.error || 'Unknown error'));
    }
    
  } catch (error) {
    console.error('Upload error:', error);
    alert('Upload failed: ' + error.message);
  }
  
  uploadArea.innerHTML = originalContent;
  isUploading = false;
}

async function uploadFromUrl() {
  const urlInput = document.getElementById('url-input');
  const url = urlInput.value.trim();
  
  if (!url || isUploading || isStreaming) return;
  
  isUploading = true;
  const btn = document.getElementById('url-upload-btn');
  const originalText = btn.textContent;
  btn.textContent = 'Uploading...';
  btn.disabled = true;
  
  try {
    const response = await fetch(API_BASE + '/upload-url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        use_llm: document.getElementById('use-llm').checked,
        webhook_url: document.getElementById('webhook-url').value || null
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      // Add to jobs list immediately
      jobs.unshift({
        job_id: result.job_id,
        filename: result.filename,
        status: 'processing',
        file_size: result.file_size,
        processing_method: result.processing_method,
        source_url: result.source_url,
        created_at: new Date().toISOString()
      });
      updateJobsList();
      
      // Reset form
      urlInput.value = '';
    } else {
      const error = await response.json();
      alert('URL upload failed: ' + (error.error || 'Unknown error'));
    }
    
  } catch (error) {
    console.error('URL upload error:', error);
    alert('URL upload failed: ' + error.message);
  }
  
  btn.textContent = originalText;
  btn.disabled = false;
  isUploading = false;
}
async function deleteJob(jobId) {
  if (!confirm('Are you sure you want to delete this job?')) return;
  
  try {
    const response = await fetch(API_BASE + '/delete-job', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ job_id: jobId })
    });
    
    if (response.ok) {
      jobs = jobs.filter(job => job.job_id !== jobId);
      updateJobsList();
      
      // Hide audio player if this job was selected
      if (selectedJob && selectedJob.job_id === jobId) {
        selectedJob = null;
        document.getElementById('audio-player').classList.add('hidden');
      }
    } else {
      const error = await response.json();
      alert('Failed to delete job: ' + (error.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Delete error:', error);
    alert('Failed to delete job: ' + error.message);
  }
}

async function viewTranscript(jobId) {
  const job = jobs.find(j => j.job_id === jobId);
  if (!job) return;
  selectedJob = job;
  
  try {
    const response = await fetch(API_BASE + '/result?job_id=' + jobId);
    if (response.ok) {
      const data = await response.json();
      showAudioPlayer(job, data);
    }
  } catch (error) {
    console.error('Failed to fetch transcript:', error);
  }
}

function showAudioPlayer(job, transcript) {
  const playerContainer = document.getElementById('audio-player');
  
  let html = '<div class="border border-terminal-border bg-terminal-bg-light">';
  
  // Header
  html += '<div class="p-4 border-b border-terminal-border flex justify-between items-center">';
  html += '<h3 class="text-lg font-bold m-0">🎵 Audio Player & Transcript</h3>';
  html += '<div class="flex items-center gap-2 text-sm">';
  html += '<span class="font-bold">' + job.filename + '</span>';
  if (job.source_url) {
    html += '<span class="text-status-info">from URL</span>';
  }
  html += '</div>';
  html += '</div>';
  
  // Content area
  html += '<div class="max-h-96 flex flex-col">';
  html += '<div class="p-4 border-b border-terminal-border flex justify-between items-center">';
  html += '<h4 class="text-sm font-bold m-0">📝 Transcript</h4>';
  html += '<span class="text-xs text-terminal-text-dim">';
  html += (transcript.partials?.length || 0) + ' segments';
  html += '</span>';
  html += '</div>';
  
  html += '<div class="flex-1 overflow-y-auto p-4">';
  
  // Final transcript
  if (transcript.final) {
    html += '<div class="mb-6">';
    html += '<div class="font-bold mb-2 text-terminal-accent border-b border-terminal-border pb-1">';
    html += 'Final (LLM Enhanced):';
    html += '</div>';
    html += '<div class="leading-relaxed whitespace-pre-wrap">' + transcript.final + '</div>';
    html += '</div>';
  }
  
  // Segmented transcript
  if (transcript.partials && transcript.partials.length > 0) {
    html += '<div class="mt-4">';
    html += '<div class="font-bold mb-2 text-terminal-accent border-b border-terminal-border pb-1">';
    html += 'Segmented (with timestamps):';
    html += '</div>';
    html += '<div class="leading-relaxed">';
    
    const segmentHtml = transcript.partials.map(partial => {
      if (partial.segments) {
        return partial.segments.map(segment => {
          const time = formatTime(segment.start || 0);
          return '<span class="inline cursor-pointer transition-all duration-200 py-0.5 hover:bg-white/10" title="Click to jump to ' + time + '">' + segment.text + '</span>';
        }).join(' ');
      } else {
        return '<span>' + partial.text + '</span>';
      }
    }).join(' ');
    
    html += segmentHtml;
    html += '</div>';
    html += '</div>';
  }
  
  html += '</div>';
  html += '</div>';
  html += '</div>';
  
  playerContainer.innerHTML = html;
  
  playerContainer.classList.remove('hidden');
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return mins + ':' + secs.toString().padStart(2, '0');
}

// Make functions globally available for onclick handlers
window.viewTranscript = viewTranscript;
window.deleteJob = deleteJob;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
