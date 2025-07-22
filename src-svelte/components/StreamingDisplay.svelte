<script>
  import { 
    isStreaming, showStreamingResults, currentStreamingFilename, streamStartTime, 
    streamingProgress, streamingTranscript, chunksProcessed, totalChunks, 
    streamingFileSize, streamingLLMMode,
    // Chunked streaming stores
    isChunkedStreaming, showChunkedStreamingResults, chunkSlots, chunkedViewMode, chunkedProgress, 
    chunkedReadableTranscript, currentChunkedJobId, chunkedTotalChunks,
    chunkedUploadedChunks, chunkedCompletedChunks, chunkedFailedChunks, 
    chunkedSuccessRate, chunkedFileSize, formatBytes
  } from '../lib/stores.js';
  
  // Local state for elapsed time
  let elapsedTime = 0;
  let elapsedTimer = null;
  let chunksToDisplay = []; // Declare the variable
  
  // Update elapsed time display
  $: if (($isStreaming || $isChunkedStreaming) && !elapsedTimer) {
    elapsedTimer = setInterval(() => {
      elapsedTime = Math.floor((Date.now() - $streamStartTime) / 1000);
    }, 1000);
  } else if (!$isStreaming && !$isChunkedStreaming && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    // Keep final elapsed time when streaming completes
    if ($showStreamingResults || $showChunkedStreamingResults) {
      elapsedTime = Math.floor((Date.now() - $streamStartTime) / 1000);
    }
  }
  
  // Auto-scroll transcript to bottom when new content is added
  $: if ($streamingTranscript) {
    setTimeout(() => {
      const transcriptEl = document.getElementById('streaming-transcript');
      if (transcriptEl) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    }, 50);
  }
  
  // Auto-scroll readable transcript when updated
  $: if ($chunkedReadableTranscript) {
    setTimeout(() => {
      const readableEl = document.getElementById('chunked-readable-transcript');
      if (readableEl) {
        readableEl.scrollTop = readableEl.scrollHeight;
      }
    }, 50);
  }
  
  // Helper function to get chunk status color
  function getChunkStatusColor(status) {
    switch (status) {
      case 'pending': return 'border-terminal-border bg-terminal-bg';
      case 'uploading': return 'border-blue-400 bg-blue-900/20 animate-pulse';
      case 'processing': return 'border-yellow-400 bg-yellow-900/20 animate-pulse';
      case 'complete': return 'border-green-400 bg-green-900/20';
      case 'failed': return 'border-red-400 bg-red-900/20';
      case 'skipped': return 'border-gray-400 bg-gray-900/20';
      default: return 'border-terminal-border bg-terminal-bg';
    }
  }
  
  // Helper function to get chunk status icon
  function getChunkStatusIcon(status) {
    switch (status) {
      case 'pending': return 'mdi:circle-outline';
      case 'uploading': return 'mdi:upload';
      case 'processing': return 'mdi:cog';
      case 'complete': return 'mdi:check-circle';
      case 'failed': return 'mdi:alert-circle';
      case 'skipped': return 'mdi:skip-forward';
      default: return 'mdi:circle-outline';
    }
  }
  
  // Time formatting helper
  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
  
  // Format timestamp to human readable with milliseconds
  function formatTimestamp(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }
  
  // Get first sentence or first N characters for preview
  function getTextPreview(text, maxChars = 100) {
    if (!text) return '';
    
    // Try to find first sentence (ending with . ! or ?)
    const sentenceMatch = text.match(/^[^.!?]*[.!?]/);
    if (sentenceMatch && sentenceMatch[0].length <= maxChars) {
      return sentenceMatch[0].trim();
    }
    
    // Fallback to character limit, break at word boundary
    if (text.length <= maxChars) return text;
    
    const truncated = text.substring(0, maxChars);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > maxChars * 0.7 ? truncated.substring(0, lastSpace) + '...' : truncated + '...';
  }
  
  // Computed: chunks to display based on view mode
  $: chunksToDisplay = $chunkedViewMode === 'speed' 
    ? $chunkSlots.filter(chunk => chunk && chunk.status === 'complete')
        .sort((a, b) => (a.arrivalOrder || 0) - (b.arrivalOrder || 0)) // Sort by arrival order
    : $chunkSlots.filter(chunk => chunk && chunk.status === 'complete').slice(0, getLastContiguousIndex($chunkSlots) + 1);
  
  function getLastContiguousIndex(slots) {
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i] || slots[i].status !== 'complete') {
        return i - 1;
      }
    }
    return slots.length - 1;
  }
</script>

<!-- Full-width Streaming Display (shown when streaming or results should be displayed) -->
{#if $isStreaming || $showStreamingResults || $isChunkedStreaming || $showChunkedStreamingResults}
  <div class="border-2 border-terminal-border bg-terminal-bg-light p-4 mb-4">
    <div class="font-bold text-center mb-4 border-b border-terminal-border pb-2 flex items-center justify-center gap-2">
      <iconify-icon icon="mdi:waveform" class="text-lg"></iconify-icon> 
      {#if $isChunkedStreaming}
        Chunked Upload Streaming
      {:else if $isStreaming}
        Live Streaming Transcription
      {:else}
        Streaming Results
      {/if}
    </div>
    
    <!-- Streaming Status -->
    <div class="mb-4">
      <div class="flex items-center gap-2 mb-2">
        {#if $isStreaming || $isChunkedStreaming}
          <span class="w-2 h-2 bg-status-info rounded-full animate-pulse"></span>
          <span class="font-bold text-status-info">
            {$isChunkedStreaming ? 'Chunked streaming in progress...' : 'Streaming in progress...'}
          </span>
        {:else}
          <span class="w-2 h-2 bg-status-success rounded-full"></span>
          <span class="font-bold text-status-success">
            {$showChunkedStreamingResults ? 'Chunked streaming completed' : 'Streaming completed'}
          </span>
        {/if}
        <span class="text-terminal-text-dim">
          {$isChunkedStreaming || $showChunkedStreamingResults ? $currentChunkedJobId : $currentStreamingFilename}
        </span>
      </div>
      
      {#if $isChunkedStreaming || $showChunkedStreamingResults}
        <!-- Chunked Streaming Progress -->
        <div class="space-y-2">
          <!-- Upload Progress -->
          <div class="bg-terminal-bg border border-terminal-border h-4 overflow-hidden">
            <div 
              class="bg-blue-500 h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" 
              style="width: {$chunkedProgress.upload}%;"
            >
              Upload {$chunkedProgress.upload}%
            </div>
          </div>
          
          <!-- Processing Progress -->
          <div class="bg-terminal-bg border border-terminal-border h-4 overflow-hidden">
            <div 
              class="bg-yellow-500 h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" 
              style="width: {$chunkedProgress.processing}%;"
            >
              Processing {$chunkedProgress.processing}%
            </div>
          </div>
          
          <!-- Overall Progress -->
          <div class="bg-terminal-bg border border-terminal-border h-5 overflow-hidden">
            <div 
              class="bg-green-500 h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" 
              style="width: {$chunkedProgress.overall}%;"
            >
              Overall {$chunkedProgress.overall}%
            </div>
          </div>
        </div>
        
        <div class="text-xs text-terminal-text-dim mt-2 grid grid-cols-2 md:grid-cols-6 gap-2">
          <span>Uploaded: {$chunkedUploadedChunks}/{$chunkedTotalChunks}</span>
          <span>Completed: {$chunkedCompletedChunks}/{$chunkedTotalChunks}</span>
          <span>Failed: {$chunkedFailedChunks}</span>
          <span>Success: {$chunkedSuccessRate}%</span>
          <span>Size: {$chunkedFileSize || '-'}</span>
          <span>Elapsed: {formatTime(elapsedTime)}</span>
        </div>
      {:else}
        <!-- Regular Streaming Progress -->
        <div class="bg-terminal-bg border border-terminal-border h-5 overflow-hidden">
          <div 
            class="bg-status-info h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" 
            style="width: {$streamingProgress}%;"
          >
            {$streamingProgress}%
          </div>
        </div>
        
        <div class="text-xs text-terminal-text-dim mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
          <span>Chunks: {$chunksProcessed}/{$totalChunks || '?'}</span>
          <span>Size: {$streamingFileSize || '-'}</span>
          <span>Elapsed: {formatTime(elapsedTime)}</span>
          <span>Mode: {$streamingLLMMode}</span>
        </div>
      {/if}
    </div>

    {#if $isChunkedStreaming || $showChunkedStreamingResults}
      <!-- Chunked Streaming Display -->
      
      <!-- View Mode Toggle -->
      <div class="mb-4 flex items-center gap-4">
        <span class="font-bold text-terminal-accent">View Mode:</span>
        <div class="flex gap-2">
          <button 
            type="button"
            on:click={() => $chunkedViewMode = 'speed'}
            class="border border-terminal-border text-terminal-text px-3 py-1 text-sm hover:bg-yellow-400 transition-colors flex items-center gap-2"
            class:bg-yellow-400={$chunkedViewMode === 'speed'}
            class:bg-terminal-bg={$chunkedViewMode !== 'speed'}
          >
            <iconify-icon icon="mdi:flash"></iconify-icon> First to Complete
          </button>
          <button 
            type="button"
            on:click={() => $chunkedViewMode = 'order'}
            class="border border-terminal-border text-terminal-text px-3 py-1 text-sm hover:bg-yellow-400 transition-colors flex items-center gap-2"
            class:bg-yellow-400={$chunkedViewMode === 'order'}
            class:bg-terminal-bg={$chunkedViewMode !== 'order'}
          >
            <iconify-icon icon="mdi:sort-numeric-ascending"></iconify-icon> In Order Only
          </button>
        </div>
        <span class="text-xs text-terminal-text-dim">
          {#if $chunkedViewMode === 'speed'}
            Shows chunks as they complete (fastest feedback)
          {:else}
            Shows only contiguous chunks in order (readable flow)
          {/if}
        </span>
      </div>
      
      <div class="space-y-4">
        <!-- Chunk Slots Grid -->
        <div class="border border-terminal-border bg-terminal-bg">
          <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent flex items-center gap-2">
            <iconify-icon icon="mdi:view-grid" class="text-lg"></iconify-icon> 
            Chunk Status Grid
            <span class="text-xs text-terminal-text-dim ml-auto">
              ({$chunkedCompletedChunks}/{$chunkedTotalChunks} completed)
            </span>
          </div>
          <div class="p-4 max-h-80 overflow-y-auto">
            <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
              {#each $chunkSlots as slot, index}
                <div 
                  class="border-2 p-2 text-center text-xs transition-all duration-300 {getChunkStatusColor(slot.status)}"
                  title="Chunk {index}: {slot.status}{slot.processingTime ? ` (${slot.processingTime}ms)` : ''}{slot.skipReason ? ` - ${slot.skipReason}` : ''}"
                >
                  <div class="flex flex-col items-center gap-1">
                    <iconify-icon icon={getChunkStatusIcon(slot.status)} class="text-sm"></iconify-icon>
                    <div class="font-bold">{index}</div>
                    {#if slot.processingTime}
                      <div class="text-xs opacity-70">{slot.processingTime}ms</div>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </div>

        <!-- First to Complete (Speed Mode) -->
        {#if $chunkedViewMode === 'speed' && chunksToDisplay.length > 0}
          <div class="border border-terminal-border bg-terminal-bg">
            <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent flex items-center gap-2">
              <iconify-icon icon="mdi:flash" class="text-lg"></iconify-icon> 
              First to Complete
              <span class="text-xs text-terminal-text-dim ml-auto">
                Arrival order • {chunksToDisplay.length} chunks ready
              </span>
            </div>
            <div class="p-4 max-h-80 overflow-y-auto space-y-3">
              {#each chunksToDisplay as chunk}
                <div class="border border-green-800 bg-green-900/10 rounded">
                  <div class="p-3">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="font-bold text-green-800">Chunk {chunk.chunkIndex}</span>
                      {#if chunk.processingTime}
                        <span class="text-xs text-terminal-text-dim">
                          ({chunk.processingTime}ms)
                        </span>
                      {/if}
                      {#if chunk.completedAt}
                        <span class="text-xs text-blue-400 font-mono">
                          {formatTimestamp(chunk.completedAt)}
                        </span>
                      {/if}
                      {#if chunk.llmApplied}
                        <span class="text-xs bg-purple-600 text-white px-2 py-1 rounded">LLM</span>
                      {/if}
                    </div>
                    
                    <details class="group">
                      <summary class="cursor-pointer text-sm font-mono text-terminal-text hover:text-terminal-accent transition-colors list-none">
                        <div class="flex items-center gap-2">
                          <span class="text-xs text-terminal-text-dim group-open:rotate-90 transition-transform">▶</span>
                          <span class="italic">"{getTextPreview(chunk.text, 80)}"</span>
                        </div>
                      </summary>
                      <div class="mt-3 pl-4 border-l-2 border-green-800/30">
                        <div class="text-sm font-mono whitespace-pre-wrap text-terminal-text">
                          "{chunk.text}"
                        </div>
                        {#if chunk.rawText && chunk.text !== chunk.rawText}
                          <div class="mt-2 pt-2 border-t border-terminal-border">
                            <div class="text-xs text-terminal-text-dim mb-1">Raw transcript:</div>
                            <div class="text-sm font-mono whitespace-pre-wrap text-terminal-text-dim">
                              "{chunk.rawText}"
                            </div>
                          </div>
                        {/if}
                      </div>
                    </details>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}
        
        <!-- In Order Display -->
        {#if $chunkedViewMode === 'order'}
          <div class="border border-terminal-border bg-terminal-bg">
            <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent flex items-center gap-2">
              <iconify-icon icon="mdi:sort-numeric-ascending" class="text-lg"></iconify-icon> 
              In Order (Sequential)
              <span class="text-xs text-terminal-text-dim ml-auto">
                Ordered chunks • {$chunkSlots.filter(slot => slot && slot.status === 'complete').length}/{$chunkedTotalChunks} completed
              </span>
            </div>
            <div class="p-4 max-h-80 overflow-y-auto space-y-3">
              {#each $chunkSlots as slot, index}
                {#if slot && slot.status === 'complete'}
                  <!-- Completed chunk -->
                  <div class="border border-green-800 bg-green-900/10 rounded">
                    <div class="p-3">
                      <div class="flex items-center gap-2 mb-2">
                        <span class="font-bold text-green-800">Chunk {index}</span>
                        {#if slot.processingTime}
                          <span class="text-xs text-terminal-text-dim">
                            ({slot.processingTime}ms)
                          </span>
                        {/if}
                        {#if slot.completedAt}
                          <span class="text-xs text-blue-400 font-mono">
                            {formatTimestamp(slot.completedAt)}
                          </span>
                        {/if}
                        {#if slot.llmApplied}
                          <span class="text-xs bg-purple-600 text-white px-2 py-1 rounded">LLM</span>
                        {/if}
                      </div>
                      
                      <details class="group">
                        <summary class="cursor-pointer text-sm font-mono text-terminal-text hover:text-terminal-accent transition-colors list-none">
                          <div class="flex items-center gap-2">
                            <span class="text-xs text-terminal-text-dim group-open:rotate-90 transition-transform">▶</span>
                            <span class="italic">"{getTextPreview(slot.text, 80)}"</span>
                          </div>
                        </summary>
                        <div class="mt-3 pl-4 border-l-2 border-green-800/30">
                          <div class="text-sm font-mono whitespace-pre-wrap text-terminal-text">
                            "{slot.text}"
                          </div>
                          {#if slot.rawText && slot.text !== slot.rawText}
                            <div class="mt-2 pt-2 border-t border-terminal-border">
                              <div class="text-xs text-terminal-text-dim mb-1">Raw transcript:</div>
                              <div class="text-sm font-mono whitespace-pre-wrap text-terminal-text-dim">
                                "{slot.rawText}"
                              </div>
                            </div>
                          {/if}
                        </div>
                      </details>
                    </div>
                  </div>
                {:else}
                  <!-- Pending/waiting chunk -->
                  <div class="border border-gray-600 bg-gray-800/20 rounded">
                    <div class="p-3">
                      <div class="flex items-center gap-2 mb-2">
                        <span class="font-bold text-gray-400">Chunk {index}</span>
                        <span class="text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded">
                          {#if slot && slot.status === 'uploading'}
                            Uploading...
                          {:else if slot && slot.status === 'processing'}
                            Processing...
                          {:else if slot && slot.status === 'failed'}
                            Failed
                          {:else}
                            Waiting
                          {/if}
                        </span>
                      </div>
                      <div class="text-sm text-gray-500 italic">
                        {#if slot && slot.status === 'failed' && slot.error}
                          Error: {slot.error}
                        {:else if slot && slot.status === 'uploading'}
                          Upload in progress...
                        {:else if slot && slot.status === 'processing'}
                          Transcription in progress...
                        {:else}
                          Waiting for previous chunks to complete
                        {/if}
                      </div>
                    </div>
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {:else}
          <!-- Readable Transcript (for speed mode) -->
          <div class="border border-terminal-border bg-terminal-bg">
            <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent flex items-center gap-2">
              <iconify-icon icon="mdi:text-box" class="text-lg"></iconify-icon> 
              Readable Transcript (Ordered)
            </div>
            <div 
              id="chunked-readable-transcript"
              class="p-4 max-h-80 overflow-y-auto font-mono text-sm leading-relaxed"
            >
              {#if $chunkedReadableTranscript}
                <pre class="whitespace-pre-wrap">{$chunkedReadableTranscript}</pre>
              {:else}
                <div class="text-terminal-text-dim italic">Waiting for chunks to complete in order...</div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
      
    {:else}
      <!-- Regular Streaming Display -->
      <div class="border border-terminal-border bg-terminal-bg">
        <div class="p-3 border-b border-terminal-border font-bold text-terminal-accent flex items-center gap-2">
          <iconify-icon icon="mdi:text-box" class="text-lg"></iconify-icon> 
          {#if $isStreaming}
            Live Transcript:
          {:else}
            Final Transcript:
          {/if}
        </div>
        <div 
          id="streaming-transcript"
          class="p-4 max-h-80 overflow-y-auto font-mono text-sm leading-relaxed"
        >
          {#if $streamingTranscript}
            <pre class="whitespace-pre-wrap">{$streamingTranscript}</pre>
          {:else}
            <div class="text-terminal-text-dim italic">Waiting for transcription results...</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if} 