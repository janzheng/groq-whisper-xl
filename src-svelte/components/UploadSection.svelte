<script>
  import { createEventDispatcher } from 'svelte';
  import { isUploading, formatBytes } from '../lib/stores.js';
  import { uploadFile, uploadFromUrl } from '../lib/api.js';
  import DirectUpload from './DirectUpload.svelte';
  import StreamingUpload from './StreamingUpload.svelte';
  import StreamingDisplay from './StreamingDisplay.svelte';

  const dispatch = createEventDispatcher();
</script>

<!-- Upload Section -->
<div class="border-2 border-terminal-border bg-terminal-bg-light p-4 mb-4">
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <DirectUpload />
    <StreamingUpload />
  </div>
</div>

<!-- Full-width Streaming Display -->
<StreamingDisplay /> 