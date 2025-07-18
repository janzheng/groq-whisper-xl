<script>
  import { formatBytes } from '../lib/stores.js';
  import { deleteJob, copyTranscript, copyJobJson } from '../lib/api.js';
  
  export let job;
  
  let expanded = false;
  let copying = false;
  let transcript = '';
  let fetchingTranscript = false;
  let transcriptFetched = false;
  
  const statusColors = {
    processing: 'bg-status-info text-terminal-bg',
    uploaded: 'bg-status-info text-terminal-bg',
    failed: 'bg-status-error text-terminal-bg',
    done: 'bg-status-success text-terminal-bg'  // Added for completed jobs
  };
  
  const statusIcons = {
    processing: 'mdi:sync',
    uploaded: 'mdi:sync',
    failed: 'mdi:alert-circle',
    done: 'mdi:check-circle'  // Added for completed jobs
  };
  
  function getStatusClass(status) {
    return statusColors[status] || 'bg-status-warning text-terminal-bg';
  }
  
  function getStatusIcon(status) {
    return statusIcons[status] || 'mdi:clock';
  }
  
  function getDisplayStatus(job) {
    if (job.status === 'processing' || job.status === 'uploaded') {
      if (job.processing_method === 'streaming') {
        return 'STREAMING';
      } else {
        return 'PROCESSING';
      }
    } else if (job.status === 'done') {
      return 'COMPLETED';  // Changed to 'COMPLETED' for better UX
    }
    return job.status.toUpperCase();
  }
  
  async function handleDelete() {
    if (!confirm('Are you sure you want to delete this job?')) return;
    
    try {
      await deleteJob(job.job_id);
    } catch (error) {
      alert('Failed to delete job: ' + error.message);
    }
  }
  
  async function handleCopyTranscript() {
    if (copying) return;
    copying = true;
    
    try {
      await copyTranscript(job.job_id);
      // Show success state briefly (handled by button state)
      setTimeout(() => copying = false, 2000);
    } catch (error) {
      alert('Failed to copy transcript: ' + error.message);
      copying = false;
    }
  }
  
  async function handleCopyJson() {
    try {
      await copyJobJson(job.job_id);
    } catch (error) {
      alert('Failed to copy job JSON: ' + error.message);
    }
  }
  
  async function fetchTranscript() {
    if (fetchingTranscript || transcriptFetched || job.processing_method === 'streaming') return;
    
    fetchingTranscript = true;
    try {
      const response = await fetch(`/result?job_id=${job.job_id}`);
      if (response.ok) {
        const data = await response.json();
        transcript = data.final || 'No transcript available';
        transcriptFetched = true;
      } else {
        transcript = 'Failed to fetch transcript';
      }
    } catch (error) {
      transcript = 'Error loading transcript: ' + error.message;
    } finally {
      fetchingTranscript = false;
    }
  }
  
  function toggleExpanded() {
    expanded = !expanded;
    // Fetch transcript when expanding a completed regular job
    if (expanded && job.status === 'done' && job.processing_method !== 'streaming') {
      fetchTranscript();
    }
  }
</script>

<div class="border-b border-terminal-border">
  <div 
    class="p-3 pr-4 hover:bg-gray-800/5 transition-colors cursor-pointer" 
    on:click={toggleExpanded}
    on:keydown={(e) => e.key === 'Enter' && toggleExpanded()}
    role="button"
    tabindex="0"
  >
    <div class="flex items-start gap-3">
      <!-- Main job info -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <iconify-icon icon="mdi:file-music" class="text-terminal-accent"></iconify-icon>
          <span class="font-bold">{job.filename || 'Unknown'}</span>
          {#if job.upload_method === 'url'}
            <span class="text-status-info text-xs bg-blue-900/30 px-1 rounded">URL</span>
          {/if}
          {#if job.upload_method === 'streaming'}
            <span class="text-status-info text-xs bg-blue-900/30 px-1 rounded">Streamed</span>
          {/if}
        </div>
        <div class="flex flex-wrap gap-3 text-xs text-terminal-text-dim">
          <span>
            <iconify-icon icon="mdi:identifier" class="text-xs"></iconify-icon> 
            {job.job_id.slice(0, 8)}...
          </span>
          <span>
            <iconify-icon icon="mdi:file-outline" class="text-xs"></iconify-icon> 
            {formatBytes(job.file_size || 0)}
          </span>
          <span>
            <iconify-icon icon="mdi:cog" class="text-xs"></iconify-icon> 
            {job.processing_method || 'direct'}
          </span>
          {#if job.total_segments > 0}
            <span>
              <iconify-icon icon="mdi:format-list-numbered" class="text-xs"></iconify-icon> 
              {job.total_segments} segments
            </span>
          {/if}
        </div>
      </div>
      
      <!-- Status and delete button -->
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="px-2 py-1 text-xs font-bold uppercase {getStatusClass(job.status)} flex items-center gap-1">
          <iconify-icon 
            icon={getStatusIcon(job.status)} 
            class="text-xs"
            class:animate-spin={job.status === 'processing' || job.status === 'uploaded'}
          ></iconify-icon> 
          {getDisplayStatus(job)}
        </div>
        <button 
          on:click|stopPropagation={handleDelete}
          class="text-status-error hover:bg-status-error hover:text-terminal-bg transition-colors p-1 rounded flex items-center justify-center" 
          title="Delete job"
        >
          <iconify-icon icon="mdi:delete" class="text-lg"></iconify-icon>
        </button>
      </div>
    </div>
    
    <!-- Progress bar ONLY for processing jobs -->
    {#if job.progress !== undefined && (job.status === 'processing' || job.status === 'uploaded')}
      <div class="bg-terminal-bg border border-terminal-border h-5 overflow-hidden mt-2">
        <div 
          class="bg-terminal-accent h-full flex items-center justify-center text-terminal-bg text-xs font-bold transition-all duration-300" 
          style="width: {job.progress || 0}%;"
        >
          {job.progress || 0}%
        </div>
      </div>
    {/if}
    
    <!-- Basic info row -->
    <div class="mt-2 flex flex-wrap gap-3 text-xs text-terminal-text-dim">
      <span>
        <iconify-icon icon="mdi:clock-outline" class="text-xs"></iconify-icon> 
        {new Date(job.created_at).toLocaleString()}
      </span>
      {#if job.use_llm}
        <span class="text-terminal-accent">
          <iconify-icon icon="mdi:brain" class="text-xs"></iconify-icon> LLM Enhanced
        </span>
      {/if}
      {#if job.error}
        <span class="text-status-error">
          <iconify-icon icon="mdi:alert-circle" class="text-xs"></iconify-icon> 
          Error: {job.error}
        </span>
      {/if}
    </div>
  </div>
  
  <!-- Expandable section -->
  {#if expanded}
    <div class="border-t border-terminal-border bg-gray-900/5 p-3">
      {#if job.status === 'done'}
        <!-- Completed job: show transcript view -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:items-start">
          <!-- Left column: Job Details + Actions -->
          <div class="lg:col-span-1 flex flex-col">
            <div class="text-terminal-accent font-bold mb-2">Job Details</div>
            <div class="space-y-1 text-xs text-terminal-text-dim mb-4">
              <div>ID: {job.job_id}</div>
              <div>Status: {job.status}</div>
              <div>Method: {job.processing_method || 'direct'}</div>
              {#if job.total_segments > 0}
                <div>Segments: {job.total_segments}</div>
              {/if}
            </div>
            
            <!-- Actions under job details -->
            <div class="text-terminal-accent font-bold mb-2">Actions</div>
            <div class="space-y-2">
              <button 
                on:click={handleCopyTranscript}
                disabled={copying}
                class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-2 py-1 text-xs hover:bg-gray-700 transition-colors flex items-center gap-1 w-full"
              >
                <iconify-icon icon="mdi:content-copy" class="text-xs"></iconify-icon> 
                {copying ? 'Copied!' : 'Copy Transcript'}
              </button>
              <button 
                on:click={handleCopyJson}
                class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-2 py-1 text-xs hover:bg-gray-700 transition-colors flex items-center gap-1 w-full"
              >
                <iconify-icon icon="mdi:code-json" class="text-xs"></iconify-icon> Copy JSON
              </button>
            </div>
          </div>
          
          <!-- Right column: Transcript Display -->
          <div class="lg:col-span-2 flex flex-col">
            <div class="text-terminal-accent font-bold mb-2">Full Transcript</div>
            <div class="border border-terminal-border bg-terminal-bg flex flex-col flex-1 min-h-0">
              <div class="p-3 border-b border-terminal-border font-bold text-terminal-text-dim text-xs flex-shrink-0">
                <iconify-icon icon="mdi:text-box" class="text-sm"></iconify-icon> 
                {#if job.processing_method === 'streaming'}
                  Final Transcript (Streaming)
                {:else}
                  Final Transcript
                {/if}
              </div>
                             <div class="p-4 flex-1 overflow-y-auto font-mono text-sm leading-relaxed min-h-[16rem]">
                 {#if job.processing_method === 'streaming'}
                   <!-- For streaming jobs, show the transcript directly from job data -->
                   {#if job.final_transcript}
                     <pre class="whitespace-pre-wrap text-terminal-text">{job.final_transcript}</pre>
                   {:else if job.corrected_transcript}
                     <pre class="whitespace-pre-wrap text-terminal-text">{job.corrected_transcript}</pre>
                   {:else if job.raw_transcript}
                     <pre class="whitespace-pre-wrap text-terminal-text">{job.raw_transcript}</pre>
                   {:else}
                     <div class="text-terminal-text-dim italic">No transcript available</div>
                   {/if}
                 {:else}
                   <!-- For regular jobs, show fetched transcript -->
                   {#if fetchingTranscript}
                     <div class="text-terminal-text-dim italic flex items-center gap-2">
                       <iconify-icon icon="mdi:loading" class="animate-spin"></iconify-icon>
                       Loading transcript...
                     </div>
                   {:else if transcriptFetched && transcript}
                     <pre class="whitespace-pre-wrap text-terminal-text">{transcript}</pre>
                   {:else if transcriptFetched}
                     <div class="text-terminal-text-dim italic">No transcript available</div>
                   {:else}
                     <div class="text-terminal-text-dim italic">
                       Transcript will load when expanded
                     </div>
                   {/if}
                 {/if}
               </div>
            </div>
          </div>
        </div>
      {:else}
        <!-- Processing job: show details -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div class="text-terminal-accent font-bold mb-2">Job Details</div>
            <div class="space-y-1 text-xs text-terminal-text-dim">
              <div>ID: {job.job_id}</div>
              <div>Status: {job.status}</div>
              <div>Upload: {job.upload_method || 'direct'}</div>
              <div>Processing: {job.processing_method || 'direct'}</div>
            </div>
          </div>
          
          <div>
            <div class="text-terminal-accent font-bold mb-2">Settings</div>
            <div class="space-y-1 text-xs text-terminal-text-dim">
              <div>LLM: {job.use_llm ? (job.llm_mode || 'enabled') : 'disabled'}</div>
              {#if job.chunk_size_mb}
                <div>Chunk Size: {job.chunk_size_mb}MB</div>
              {/if}
              <div>File Size: {formatBytes(job.file_size || 0)}</div>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div> 