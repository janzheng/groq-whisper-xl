<script>
  import { isUploading, formatBytes } from '../lib/stores.js';
  import { uploadFile, uploadFromUrl } from '../lib/api.js';
  
  let sourceMode = 'file'; // 'file' or 'url'
  let selectedFile = null;
  let url = '';
  let useLLM = false;
  let webhookUrl = '';
  let uploadAreaElement;
  let fileInput;
  let uploadAreaContent = getDefaultUploadAreaContent();
  
  function getDefaultUploadAreaContent() {
    return {
      icon: 'mdi:file-plus',
      title: 'Drop files here or click to browse',
      subtitle: 'MP3, WAV, M4A, FLAC, etc. (up to 1GB)'
    };
  }
  
  function updateUploadAreaWithFile(file) {
    uploadAreaContent = {
      icon: 'mdi:file-music',
      title: file.name,
      subtitle: `Ready to transcribe (${formatBytes(file.size)})`,
      description: 'Click "Transcribe Audio" to start'
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
  
  async function handleDirectProcess() {
    if ($isUploading) return;
    
    if (sourceMode === 'file') {
      if (selectedFile) {
        try {
          $isUploading = true;
          
          // Stage 1: File Upload
          uploadAreaContent = {
            icon: 'mdi:upload',
            title: `Uploading ${selectedFile.name}...`,
            subtitle: `${formatBytes(selectedFile.size)} - Please wait`
          };
          
          // Brief delay to show upload message
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Stage 2: Processing
          uploadAreaContent = {
            icon: 'mdi:loading',
            title: `Processing ${selectedFile.name}...`,
            subtitle: 'Transcribing audio with Groq Whisper'
          };
          
          await uploadFile(selectedFile, useLLM, webhookUrl || null);
          
          uploadAreaContent = {
            icon: 'mdi:check',
            title: `${selectedFile.name} uploaded successfully!`,
            subtitle: 'Check "Jobs" section for progress',
            success: true
          };
          
          setTimeout(() => {
            resetUploadArea();
          }, 3000);
          
        } catch (error) {
          uploadAreaContent = {
            icon: 'mdi:alert-circle',
            title: 'Upload failed',
            subtitle: error.message,
            error: true
          };
          
          setTimeout(() => {
            resetUploadArea();
          }, 3000);
        } finally {
          $isUploading = false;
        }
      } else {
        triggerFileSelect();
      }
    } else if (sourceMode === 'url') {
      if (url.trim()) {
        try {
          $isUploading = true;
          await uploadFromUrl(url.trim(), useLLM, webhookUrl || null);
          
          // Reset form on success
          url = '';
          
        } catch (error) {
          alert('Upload failed: ' + error.message);
        } finally {
          $isUploading = false;
        }
      } else {
        alert('Please enter an audio URL first');
      }
    }
  }
  
  function setSourceMode(mode) {
    sourceMode = mode;
    if (mode === 'file') {
      resetUploadArea();
    }
  }
</script>

<!-- Direct Upload Section -->
<div class="border border-terminal-border p-4 flex flex-col">
  <div class="flex items-center gap-2 mb-4 font-bold text-terminal-accent">
    <iconify-icon icon="mdi:rocket-launch" class="text-lg"></iconify-icon>
    <span>Direct Upload & Processing</span>
  </div>
  <div class="text-xs text-terminal-text-dim mb-4">
    Upload your file and get notified when processing is complete. Files are processed in the background - check "Running Jobs" for progress.
  </div>
  
  <!-- Source Selection -->
  <div class="mb-4">
    <div class="font-bold mb-2">Source:</div>
    <div class="flex gap-2 mb-3">
      <button 
        on:click={() => setSourceMode('file')}
        class="border border-terminal-border text-terminal-text px-4 py-2 hover:bg-gray-700 transition-colors flex-1 flex items-center justify-center gap-2"
        class:bg-gray-700={sourceMode === 'file'}
        class:bg-terminal-bg={sourceMode !== 'file'}
      >
        <iconify-icon icon="mdi:file-outline"></iconify-icon> File
      </button>
      <button 
        on:click={() => setSourceMode('url')}
        class="border border-terminal-border text-terminal-text px-4 py-2 hover:bg-gray-700 transition-colors flex-1 flex items-center justify-center gap-2"
        class:bg-gray-700={sourceMode === 'url'}
        class:bg-terminal-bg={sourceMode !== 'url'}
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
        class:text-status-success={uploadAreaContent.success}
        class:text-status-error={uploadAreaContent.error}
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
        on:change={handleFileSelect}
      >
      
    {:else if sourceMode === 'url'}
      <!-- URL input -->
      <input 
        bind:value={url}
        class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent" 
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
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" bind:checked={useLLM} class="w-4 h-4">
          <iconify-icon icon="mdi:brain" class="text-terminal-accent"></iconify-icon>
          <span class="text-terminal-accent">LLM Error Correction</span>
          <span class="text-terminal-text-dim">(Improves accuracy)</span>
        </label>
      </div>
      
      <div>
        <label for="webhook-url" class="text-terminal-text-dim block mb-1">Webhook URL (optional):</label>
        <input 
          id="webhook-url"
          bind:value={webhookUrl}
          class="bg-terminal-bg-light border border-terminal-border text-terminal-text px-3 py-2 w-full focus:outline-none focus:border-terminal-accent" 
          type="url" 
          placeholder="https://your-webhook.com/endpoint"
        >
      </div>
    </div>
  </div>
  
  <button 
    on:click={handleDirectProcess}
    disabled={$isUploading}
    class="bg-terminal-accent text-terminal-bg px-4 py-2 hover:bg-gray-300 transition-colors w-full font-bold flex items-center justify-center gap-2"
    class:opacity-50={$isUploading}
  >
    <iconify-icon icon="mdi:microphone"></iconify-icon> 
    {#if $isUploading}
      Processing...
    {:else}
      Transcribe Audio
    {/if}
  </button>
</div> 