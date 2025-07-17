<script>
  import { isStreaming, showStreamingResults, currentStreamingFilename, streamStartTime, streamingProgress, streamingTranscript, chunksProcessed, totalChunks, streamingFileSize, streamingLLMMode } from '../lib/stores.js';
  
  // Local state for elapsed time
  let elapsedTime = 0;
  let elapsedTimer = null;
  
  // Update elapsed time display
  $: if ($isStreaming && !elapsedTimer) {
    elapsedTimer = setInterval(() => {
      elapsedTime = Math.floor((Date.now() - $streamStartTime) / 1000);
    }, 1000);
  } else if (!$isStreaming && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
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
</script>

<!-- Full-width Streaming Display (shown when streaming or results should be displayed) -->
{#if $isStreaming || $showStreamingResults}
  <div class="border border-terminal-border bg-terminal-bg-light p-4 mb-4">
    <div class="font-bold text-center mb-4 border-b border-terminal-border pb-2 flex items-center justify-center gap-2">
      <iconify-icon icon="mdi:waveform" class="text-lg"></iconify-icon> 
      {#if $isStreaming}
        Live Streaming Transcription
      {:else}
        Streaming Results
      {/if}
    </div>
    
    <!-- Streaming Status -->
    <div class="mb-4">
      <div class="flex items-center gap-2 mb-2">
        {#if $isStreaming}
          <span class="w-2 h-2 bg-status-info rounded-full animate-pulse"></span>
          <span class="font-bold text-status-info">Streaming in progress...</span>
        {:else}
          <span class="w-2 h-2 bg-status-success rounded-full"></span>
          <span class="font-bold text-status-success">Streaming completed</span>
        {/if}
        <span class="text-terminal-text-dim">{$currentStreamingFilename}</span>
      </div>
      
             <!-- Progress bar -->
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
         <span>Elapsed: {elapsedTime}s</span>
         <span>Mode: {$streamingLLMMode}</span>
       </div>
    </div>
    
    <!-- Live Transcript -->
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
  </div>
{/if} 