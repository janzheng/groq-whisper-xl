#!/usr/bin/env node

import { readFileSync, existsSync, statSync } from 'fs';
import { createReadStream } from 'fs';
import { basename, extname } from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';
import { config } from 'dotenv';

// Load environment variables
config();

// Configuration
const DEFAULT_BASE_URL = process.env.LOCAL_URL || 'http://localhost:8787';
const PRODUCTION_URL = process.env.PRODUCTION_URL || 'https://your-worker-name.your-subdomain.workers.dev';

class GroqWhisperCLI {
  constructor() {
    this.baseUrl = DEFAULT_BASE_URL;
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async question(prompt) {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  async showWelcome() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    🎤 Groq Whisper XL CLI                   ║
║              Universal Audio Transcription Tool             ║
╚══════════════════════════════════════════════════════════════╝

✨ Features:
• 🚀 Ultra-fast transcription using Groq's Whisper API
• 📁 Universal file support (MB to 100GB+)
• 🎯 Smart tier detection (Standard/Advanced/Enterprise)
• 🤖 LLM error correction for improved accuracy
• 🌐 URL-based audio processing
• 📊 Real-time progress tracking

Current endpoint: ${this.baseUrl}
`);
  }

  async showMainMenu() {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│                        Main Menu                            │
├─────────────────────────────────────────────────────────────┤
│ Upload Methods:                                             │
│   1. 📤 Direct Upload (Recommended)                         │
│   2. 🌐 URL Upload (From web)                               │
│   3. 🔧 Presigned Upload (Advanced)                         │
│                                                             │
│ Job Management:                                             │
│   4. 📋 List Jobs                                           │
│   5. 📊 Check Job Status                                    │
│   6. 📄 Get Job Results                                     │
│   7. 🗑️  Delete Job                                          │
│                                                             │
│ Settings:                                                   │
│   8. ⚙️  Change Endpoint                                     │
│   9. ❓ Help & Examples                                     │
│   0. 🚪 Exit                                                │
└─────────────────────────────────────────────────────────────┘
`);

    const choice = await this.question('Choose an option (0-9): ');
    return choice.trim();
  }

  async changeEndpoint() {
    console.log(`\n🔧 Change Endpoint\n`);
    console.log(`Current endpoint: ${this.baseUrl}`);
    console.log(`\nOptions:`);
    console.log(`1. Local development (${DEFAULT_BASE_URL})`);
    console.log(`2. Production (${PRODUCTION_URL})`);
    console.log(`3. Custom URL`);

    const choice = await this.question('\nChoose option (1-3): ');
    
    switch (choice.trim()) {
      case '1':
        this.baseUrl = DEFAULT_BASE_URL;
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '2':
        this.baseUrl = PRODUCTION_URL;
        console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        break;
      case '3':
        const customUrl = await this.question('Enter custom URL: ');
        if (customUrl.trim()) {
          this.baseUrl = customUrl.trim().replace(/\/$/, ''); // Remove trailing slash
          console.log(`✅ Endpoint set to: ${this.baseUrl}`);
        }
        break;
      default:
        console.log('❌ Invalid choice');
    }
  }

  async showHelp() {
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│                     Help & Examples                        │
└─────────────────────────────────────────────────────────────┘

🎯 Processing Tiers (Automatic Detection):
┌─────────────┬─────────────┬─────────────────────────────────┐
│ Tier        │ File Size   │ Features                        │
├─────────────┼─────────────┼─────────────────────────────────┤
│ Standard    │ ≤ 15MB      │ Direct processing, fastest      │
│ Advanced    │ 15MB-100MB  │ Chunking, progress tracking     │
│ Enterprise  │ > 100MB     │ Advanced chunking, monitoring   │
└─────────────┴─────────────┴─────────────────────────────────┘

📤 Upload Methods:

1. Direct Upload (Recommended)
   • Best for: Web forms, mobile apps, simple integrations
   • Complexity: ⭐ Simple
   • Single-step process with immediate processing

2. URL Upload
   • Best for: Processing audio from web URLs, podcasts
   • Complexity: ⭐ Simple  
   • Downloads and processes files from any public URL

3. Presigned Upload (Advanced)
   • Best for: Large files, custom upload logic
   • Complexity: ⭐⭐ Advanced
   • Two-step process for maximum control

💡 Pro Tips:
• Enable LLM correction for better transcript quality
• Monitor progress for large files
• Save job IDs to retrieve results later
• Files are automatically cleaned up after 24 hours

🎵 Supported Formats:
Audio: MP3, WAV, FLAC, M4A, OGG, AAC, WMA
Video: MP4, MPEG, WEBM (audio track extracted)
`);
  }

  async directUpload() {
    console.log(`\n📤 Direct Upload\n`);
    
    const filePath = await this.question('Enter file path: ');
    
    if (!existsSync(filePath)) {
      console.log('❌ File not found');
      return;
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const filename = basename(filePath);
    
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Size: ${this.formatBytes(fileSize)}`);
    console.log(`🎯 Processing tier: ${fileSize <= 15 * 1024 * 1024 ? 'Standard' : fileSize <= 100 * 1024 * 1024 ? 'Advanced' : 'Enterprise'}`);

    const useLLM = await this.question('\nEnable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    console.log('\n🚀 Uploading and processing...');

    try {
      // Create FormData equivalent
      const fileBuffer = readFileSync(filePath);
      const formData = new FormData();
      
      const blob = new Blob([fileBuffer], { 
        type: this.getContentType(extname(filename)) 
      });
      
      formData.append('file', blob, filename);
      formData.append('use_llm', useLLM.toLowerCase().startsWith('y') ? 'true' : 'false');
      
      if (webhookUrl.trim()) {
        formData.append('webhook_url', webhookUrl.trim());
      }

      const response = await fetch(`${this.baseUrl}/upload`, {
        method: 'POST',
        body: formData
      });

      const result = await response.json();

      if (!response.ok) {
        console.log(`❌ Upload failed: ${result.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Upload successful!');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      console.log(`📊 File size: ${this.formatBytes(result.file_size)}`);
      console.log(`⚙️  Processing method: ${result.processing_method}`);

      // Monitor progress
      await this.monitorJob(result.job_id, true);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async urlUpload() {
    console.log(`\n🌐 URL Upload\n`);
    
    const url = await this.question('Enter audio URL: ');
    if (!url.trim()) {
      console.log('❌ URL is required');
      return;
    }

    const filename = await this.question('Custom filename (optional, press Enter to auto-detect): ');
    const useLLM = await this.question('Enable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    console.log('\n🌐 Downloading and processing...');

    try {
      const payload = {
        url: url.trim(),
        use_llm: useLLM.toLowerCase().startsWith('y'),
      };

      if (filename.trim()) {
        payload.filename = filename.trim();
      }

      if (webhookUrl.trim()) {
        payload.webhook_url = webhookUrl.trim();
      }

      const response = await fetch(`${this.baseUrl}/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok) {
        console.log(`❌ Upload failed: ${result.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Download and upload successful!');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      console.log(`🌐 Source URL: ${result.source_url}`);
      console.log(`📊 File size: ${this.formatBytes(result.file_size)}`);
      console.log(`⚙️  Processing method: ${result.processing_method}`);

      // Monitor progress
      await this.monitorJob(result.job_id, true);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async presignedUpload() {
    console.log(`\n🔧 Presigned Upload (Advanced)\n`);
    
    const filePath = await this.question('Enter file path: ');
    
    if (!existsSync(filePath)) {
      console.log('❌ File not found');
      return;
    }

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const filename = basename(filePath);
    
    console.log(`📁 File: ${filename}`);
    console.log(`📊 Size: ${this.formatBytes(fileSize)}`);

    const useLLM = await this.question('\nEnable LLM correction for better quality? (y/N): ');
    const webhookUrl = await this.question('Webhook URL (optional, press Enter to skip): ');

    try {
      // Step 1: Get presigned URL
      console.log('\n🔗 Step 1: Getting presigned URL...');
      
      const payload = {
        filename,
        size: fileSize,
        use_llm: useLLM.toLowerCase().startsWith('y'),
      };

      if (webhookUrl.trim()) {
        payload.webhook_url = webhookUrl.trim();
      }

      const presignResponse = await fetch(`${this.baseUrl}/get-presigned-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const presignResult = await presignResponse.json();

      if (!presignResponse.ok) {
        console.log(`❌ Failed to get presigned URL: ${presignResult.error || 'Unknown error'}`);
        return;
      }

      console.log(`✅ Presigned URL obtained`);
      console.log(`📋 Job ID: ${presignResult.job_id}`);

      // Step 2: Upload file
      console.log('\n📤 Step 2: Uploading file...');
      
      const fileBuffer = readFileSync(filePath);
      
      const uploadResponse = await fetch(presignResult.upload_url, {
        method: 'PUT',
        body: fileBuffer,
        headers: {
          'Content-Type': this.getContentType(extname(filename))
        }
      });

      if (!uploadResponse.ok) {
        console.log(`❌ File upload failed: ${uploadResponse.statusText}`);
        return;
      }

      console.log('✅ File uploaded successfully');

      // Step 3: Start processing
      console.log('\n⚙️  Step 3: Starting processing...');
      
      const startResponse = await fetch(`${this.baseUrl}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: presignResult.job_id })
      });

      const startResult = await startResponse.json();

      if (!startResponse.ok) {
        console.log(`❌ Failed to start processing: ${startResult.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Processing started');
      console.log(`📊 File size: ${this.formatBytes(startResult.file_size)}`);
      console.log(`⚙️  Processing method: ${startResult.processing_method}`);

      // Monitor progress
      await this.monitorJob(presignResult.job_id, true);

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async monitorJob(jobId, autoShowResults = false) {
    console.log(`\n📊 Monitoring job: ${jobId}`);
    console.log('Press Ctrl+C to stop monitoring (job will continue in background)\n');

    const startTime = Date.now();
    let lastStatus = '';

    while (true) {
      try {
        const response = await fetch(`${this.baseUrl}/status?job_id=${jobId}`);
        const status = await response.json();

        if (!response.ok) {
          console.log(`❌ Error checking status: ${status.error || 'Unknown error'}`);
          break;
        }

        const elapsed = this.formatDuration(Date.now() - startTime);
        const statusEmoji = {
          'uploaded': '📁',
          'processing': '⚙️',
          'done': '✅',
          'failed': '❌'
        }[status.status] || '🔄';

        const progressBar = this.createProgressBar(status.progress || 0);
        const statusLine = `${statusEmoji} Status: ${status.status.toUpperCase()} | Progress: ${progressBar} ${status.progress || 0}% | Elapsed: ${elapsed}`;

        // Clear line and write new status
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        process.stdout.write(statusLine);

        if (status.status === 'done') {
          console.log('\n\n🎉 Processing completed successfully!');
          
          if (autoShowResults) {
            await this.getJobResults(jobId);
          } else {
            console.log(`\nTo get results, use option 6 with job ID: ${jobId}`);
          }
          break;
        } else if (status.status === 'failed') {
          console.log(`\n\n❌ Processing failed: ${status.error || 'Unknown error'}`);
          break;
        }

        lastStatus = status.status;
        await this.sleep(2000); // Check every 2 seconds

      } catch (error) {
        console.log(`\n❌ Error monitoring job: ${error.message}`);
        break;
      }
    }
  }

  createProgressBar(progress, width = 30) {
    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }

  async listJobs() {
    console.log(`\n📋 Listing Jobs\n`);
    
    const limit = await this.question('Number of jobs to show (default 20): ');
    const statusFilter = await this.question('Filter by status (done/processing/failed, or press Enter for all): ');

    try {
      let url = `${this.baseUrl}/jobs`;
      const params = new URLSearchParams();
      
      if (limit.trim() && !isNaN(limit.trim())) {
        params.append('limit', limit.trim());
      } else {
        params.append('limit', '20');
      }
      
      if (statusFilter.trim()) {
        params.append('status', statusFilter.trim());
      }

      if (params.toString()) {
        url += '?' + params.toString();
      }

      const response = await fetch(url);
      const result = await response.json();

      if (!response.ok) {
        console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        return;
      }

      if (result.jobs.length === 0) {
        console.log('📭 No jobs found');
        return;
      }

      console.log(`\n📊 Showing ${result.showing} of ${result.total} jobs:\n`);

      // Table header
      console.log('┌─────────────────────────────────────┬──────────────────┬───────────┬──────────┬──────────────┬─────────────────────┐');
      console.log('│ Job ID                              │ Filename         │ Status    │ Progress │ File Size    │ Created             │');
      console.log('├─────────────────────────────────────┼──────────────────┼───────────┼──────────┼──────────────┼─────────────────────┤');

      for (const job of result.jobs) {
        const jobId = job.job_id.substring(0, 35);
        const filename = (job.filename || 'Unknown').substring(0, 15);
        const status = job.status.substring(0, 10);
        const progress = `${job.progress || 0}%`.padStart(7);
        const fileSize = this.formatBytes(job.file_size || 0).substring(0, 11);
        const created = new Date(job.created_at).toLocaleString().substring(0, 18);

        console.log(`│ ${jobId.padEnd(35)} │ ${filename.padEnd(15)} │ ${status.padEnd(9)} │ ${progress} │ ${fileSize.padEnd(11)} │ ${created.padEnd(18)} │`);
      }

      console.log('└─────────────────────────────────────┴──────────────────┴───────────┴──────────┴──────────────┴─────────────────────┘');

      if (result.filters) {
        console.log(`\nFilters applied: ${JSON.stringify(result.filters)}`);
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async checkJobStatus() {
    console.log(`\n📊 Check Job Status\n`);
    
    const jobId = await this.question('Enter job ID: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    await this.monitorJob(jobId.trim(), false);
  }

  async getJobResults(jobId = null) {
    if (!jobId) {
      console.log(`\n📄 Get Job Results\n`);
      jobId = await this.question('Enter job ID: ');
      if (!jobId.trim()) {
        console.log('❌ Job ID is required');
        return;
      }
      jobId = jobId.trim();
    }

    try {
      const response = await fetch(`${this.baseUrl}/result?job_id=${jobId}`);
      const result = await response.json();

      if (!response.ok) {
        if (result.error === 'Not ready') {
          console.log(`⏳ Job not ready yet. Status: ${result.status}, Progress: ${result.progress}%`);
          const monitor = await this.question('Monitor progress? (y/N): ');
          if (monitor.toLowerCase().startsWith('y')) {
            await this.monitorJob(jobId, true);
          }
        } else {
          console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        }
        return;
      }

      console.log('\n🎉 Transcription Results:\n');

      // Show final transcript
      console.log('📝 Final Transcript:');
      console.log('─'.repeat(80));
      console.log(result.final || 'No transcript available');
      console.log('─'.repeat(80));

      // Show partial results if available
      if (result.partials && result.partials.length > 1) {
        console.log(`\n📊 Processing Details (${result.partials.length} chunks):`);
        
        for (let i = 0; i < result.partials.length; i++) {
          const partial = result.partials[i];
          console.log(`\nChunk ${i + 1}:`);
          console.log(`  Text: ${partial.text.substring(0, 100)}${partial.text.length > 100 ? '...' : ''}`);
          if (partial.segments && partial.segments.length > 0) {
            console.log(`  Segments: ${partial.segments.length}`);
            console.log(`  Duration: ${partial.segments[0].start}s - ${partial.segments[partial.segments.length - 1].end}s`);
          }
        }
      }

      // Ask to save results
      const save = await this.question('\nSave transcript to file? (y/N): ');
      if (save.toLowerCase().startsWith('y')) {
        const filename = await this.question('Enter filename (default: transcript.txt): ');
        const outputFile = filename.trim() || 'transcript.txt';
        
        try {
          const fs = await import('fs');
          fs.writeFileSync(outputFile, result.final || 'No transcript available');
          console.log(`✅ Transcript saved to: ${outputFile}`);
        } catch (error) {
          console.log(`❌ Error saving file: ${error.message}`);
        }
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async deleteJob() {
    console.log(`\n🗑️ Delete Job\n`);
    
    const jobId = await this.question('Enter job ID to delete: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    const confirm = await this.question(`⚠️  Are you sure you want to delete job ${jobId.trim()}? This will remove the job and its files. (y/N): `);
    if (!confirm.toLowerCase().startsWith('y')) {
      console.log('❌ Deletion cancelled');
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/delete-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId.trim() })
      });

      const result = await response.json();

      if (!response.ok) {
        console.log(`❌ Error: ${result.error || 'Unknown error'}`);
        return;
      }

      console.log('✅ Job deleted successfully');
      console.log(`📋 Job ID: ${result.job_id}`);
      console.log(`📁 Filename: ${result.filename}`);
      if (result.deleted_file) {
        console.log(`🗑️ Deleted file: ${result.deleted_file}`);
      }

    } catch (error) {
      console.log(`❌ Error: ${error.message}`);
    }
  }

  getContentType(extension) {
    const contentTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.m4a': 'audio/mp4',
      '.ogg': 'audio/ogg',
      '.aac': 'audio/aac',
      '.wma': 'audio/x-ms-wma',
      '.mp4': 'video/mp4',
      '.mpeg': 'video/mpeg',
      '.webm': 'video/webm'
    };
    return contentTypes[extension.toLowerCase()] || 'audio/*';
  }

  async run() {
    await this.showWelcome();

    while (true) {
      try {
        const choice = await this.showMainMenu();

        switch (choice) {
          case '1':
            await this.directUpload();
            break;
          case '2':
            await this.urlUpload();
            break;
          case '3':
            await this.presignedUpload();
            break;
          case '4':
            await this.listJobs();
            break;
          case '5':
            await this.checkJobStatus();
            break;
          case '6':
            await this.getJobResults();
            break;
          case '7':
            await this.deleteJob();
            break;
          case '8':
            await this.changeEndpoint();
            break;
          case '9':
            await this.showHelp();
            break;
          case '0':
            console.log('\n👋 Goodbye!');
            this.rl.close();
            process.exit(0);
            break;
          default:
            console.log('❌ Invalid choice. Please try again.');
        }

        // Wait for user to continue
        console.log('\n');
        await this.question('Press Enter to continue...');
        console.clear();

      } catch (error) {
        console.log(`❌ Unexpected error: ${error.message}`);
        await this.question('Press Enter to continue...');
      }
    }
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  process.exit(0);
});

// Run the CLI
const cli = new GroqWhisperCLI();
cli.run().catch(console.error); 