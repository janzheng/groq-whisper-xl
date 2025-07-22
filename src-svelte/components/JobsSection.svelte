<script>
  import { onMount, onDestroy } from 'svelte';
  import { jobs } from '../lib/stores.js';
  import { fetchJobs, deleteAllJobs } from '../lib/api.js';
  import JobItem from './JobItem.svelte';
  
  let refreshing = false;
  let autoRefreshTimer = null;
  
  // Check if there are any running jobs to determine if we need polling
  $: hasRunningJobs = $jobs.some(job => 
    job.status === 'processing' || 
    job.status === 'uploaded' || 
    job.status === 'awaiting_upload'
  );
  
  // Auto-refresh every 3 seconds when there are running jobs
  onMount(() => {
    startAutoRefresh();
  });
  
  onDestroy(() => {
    stopAutoRefresh();
  });
  
  function startAutoRefresh() {
    if (!autoRefreshTimer) {
      autoRefreshTimer = setInterval(async () => {
        // Only auto-refresh if there are running jobs
        if (hasRunningJobs) {
          try {
            await fetchJobs();
          } catch (error) {
            console.error('Auto-refresh failed:', error);
          }
        }
      }, 3000);
    }
  }
  
  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }
  
  // Start/stop auto-refresh based on running jobs
  $: {
    if (hasRunningJobs) {
      startAutoRefresh();
    } else if (!hasRunningJobs && autoRefreshTimer) {
      // Keep polling for a bit after all jobs complete to catch final status updates
      setTimeout(() => {
        if (!hasRunningJobs) {
          stopAutoRefresh();
        }
      }, 10000); // Stop 10 seconds after no running jobs
    }
  }
  
  // Also add more frequent polling when jobs are completing (every 1 second instead of 3)
  let fastRefreshTimer = null;
  
  // Fast refresh when jobs are in critical completion states
  $: hasCompletingJobs = $jobs.some(job => 
    job.status === 'processing' && 
    job.progress && 
    job.progress > 80 // Jobs that are >80% complete
  );
  
  $: {
    if (hasCompletingJobs && !fastRefreshTimer) {
      console.log('Starting fast refresh for completing jobs');
      fastRefreshTimer = setInterval(async () => {
        if (hasCompletingJobs) {
          try {
            await fetchJobs();
          } catch (error) {
            console.error('Fast refresh failed:', error);
          }
        }
      }, 1000); // Every 1 second for jobs >80% complete
    } else if (!hasCompletingJobs && fastRefreshTimer) {
      console.log('Stopping fast refresh');
      clearInterval(fastRefreshTimer);
      fastRefreshTimer = null;
    }
  }
  
  onDestroy(() => {
    stopAutoRefresh();
    if (fastRefreshTimer) {
      clearInterval(fastRefreshTimer);
      fastRefreshTimer = null;
    }
  });
  
  async function handleRefresh() {
    refreshing = true;
    try {
      await fetchJobs();
      // Keep the refreshing state for at least 1.5 seconds for user feedback
      setTimeout(() => refreshing = false, 1500);
    } catch (error) {
      console.error('Refresh failed:', error);
      refreshing = false;
    }
  }

  async function handleDeleteAll() {
    if (confirm('Are you sure you want to delete all jobs? This action cannot be undone.')) {
      try {
        await deleteAllJobs();
        console.log('All jobs deleted from API.');
      } catch (error) {
        console.error('Failed to delete all jobs:', error);
      }
    }
  }
</script>

<div>
  <!-- Jobs Header with Count and Refresh -->
  <div class="flex items-center justify-between py-2 border-b border-terminal-border">
    <div class="flex items-center gap-2">
      <span class="font-bold">Jobs ({$jobs.length})</span>
      {#if hasRunningJobs}
        <span class="text-xs bg-status-info text-terminal-bg px-2 py-1 rounded">
          {$jobs.filter(job => job.status === 'processing' || job.status === 'uploaded' || job.status === 'awaiting_upload').length} Running
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <button
        on:click={handleDeleteAll}
        disabled={$jobs.length === 0}
        class="bg-terminal-bg-light border border-terminal-border text-status-error px-3 py-1 text-xs hover:bg-red-900/30 transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <iconify-icon 
          icon="mdi:delete-sweep" 
          class="text-sm"
        ></iconify-icon>
        Delete All
      </button>
      <button
        on:click={handleRefresh}
        disabled={refreshing}
        class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-1 text-xs hover:bg-gray-700 transition-colors flex items-center gap-1"
      >
        <iconify-icon 
          icon={refreshing ? 'mdi:loading' : 'mdi:refresh'} 
          class="text-sm"
          class:animate-spin={refreshing}
        ></iconify-icon>
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </div>
  
  <!-- Jobs List -->
  {#if $jobs.length === 0}
    <div class="py-10 px-5 text-center text-terminal-text-dim">
      No jobs yet
    </div>
  {:else}
    <div class="border border-x-2 border-terminal-border">
      {#each $jobs as job (job.job_id)}
        <JobItem {job} />
      {/each}
    </div>
  {/if}
</div> 