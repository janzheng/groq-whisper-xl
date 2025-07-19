/**
 * Job Manager for Groq Whisper CLI
 * Handles job listing, monitoring, results retrieval, and cleanup operations
 */

import { LoadingIndicator, AnimatedText } from './ui-helpers.js';

export class JobManager {
  constructor(baseUrl, cliInstance) {
    this.baseUrl = baseUrl;
    this.cli = cliInstance; // Reference to CLI for shared utilities
  }

  async listJobs() {
    console.log(`\n📋 Listing Jobs\n`);
    
    const limit = await this.cli.question('Number of jobs to show (default 20): ');
    const statusFilter = await this.cli.question('Filter by status (done/processing/failed, or press Enter for all): ');

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

      const loader = new LoadingIndicator();
      loader.start('📋 Fetching job list...', 'dots', '\x1b[36m');

      const response = await fetch(url);
      const result = await response.json();
      
      loader.stop();

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
        const fileSize = this.cli.formatBytes(job.file_size || 0).substring(0, 11);
        const created = new Date(job.created_at).toLocaleString().substring(0, 18);

        console.log(`│ ${jobId.padEnd(35)} │ ${filename.padEnd(15)} │ ${status.padEnd(9)} │ ${progress} │ ${fileSize.padEnd(11)} │ ${created.padEnd(18)} │`);
      }

      console.log('└─────────────────────────────────────┴──────────────────┴───────────┴──────────┴──────────────┴─────────────────────┘');

      if (result.filters) {
        console.log(`\nFilters applied: ${JSON.stringify(result.filters)}`);
      }

    } catch (error) {
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async checkJobStatus() {
    console.log(`\n📊 Check Job Status\n`);
    
    const jobId = await this.cli.question('Enter job ID: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    await this.monitorJob(jobId.trim(), false);
  }

  async monitorJob(jobId, autoShowResults = false) {
    console.log(`\n📊 ${AnimatedText.glow('Monitoring job:')} ${jobId}`);
    console.log('Press Ctrl+C to stop monitoring (job will continue in background)\n');

    const startTime = Date.now();
    let lastStatus = '';
    let spinner = null;

    while (true) {
      try {
        const response = await fetch(`${this.baseUrl}/status?job_id=${jobId}`);
        const status = await response.json();

        if (!response.ok) {
          if (spinner) spinner.stop();
          console.log(`❌ Error checking status: ${status.error || 'Unknown error'}`);
          break;
        }

        const elapsed = this.cli.formatDuration(Date.now() - startTime);
        const progress = status.progress || 0;
        
        // Use different spinner types based on status
        const spinnerType = {
          'uploaded': 'pulse',
          'processing': 'dots',
          'done': 'star',
          'failed': 'box'
        }[status.status] || 'dots';

        const statusColors = {
          'uploaded': '\x1b[33m',  // Yellow
          'processing': '\x1b[36m', // Cyan
          'done': '\x1b[32m',      // Green
          'failed': '\x1b[31m'     // Red
        };

        // If status changed, restart spinner
        if (status.status !== lastStatus) {
          if (spinner) spinner.stop();
          
          if (status.status === 'processing') {
            spinner = new LoadingIndicator();
            spinner.start(`🔄 Processing... ${progress}% | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
          } else if (status.status === 'uploaded') {
            spinner = new LoadingIndicator();
            spinner.start(`📁 File uploaded, waiting to start... | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
          }
        } else if (spinner && status.status === 'processing') {
          // Update the spinner message with current progress
          spinner.stop();
          spinner.start(`🔄 Processing... ${progress}% | Elapsed: ${elapsed}`, spinnerType, statusColors[status.status]);
        }

        if (status.status === 'done') {
          if (spinner) spinner.stop();
          
          // Show completion animation
          console.log('\n🎉 ' + AnimatedText.rainbow('Processing completed successfully!'));
          
          if (autoShowResults) {
            await this.getJobResults(jobId);
          } else {
            console.log(`\nTo get results, use option 7 with job ID: ${jobId}`);
          }
          break;
        } else if (status.status === 'failed') {
          if (spinner) spinner.stop();
          console.log(`\n\n❌ Processing failed: ${status.error || 'Unknown error'}`);
          break;
        }

        lastStatus = status.status;
        await this.cli.sleep(1000); // Check every second for more responsive updates

      } catch (error) {
        if (spinner) spinner.stop();
        console.log(`\n❌ Error monitoring job: ${error.message}`);
        break;
      }
    }
  }

  async getJobResults(jobId = null) {
    if (!jobId) {
      console.log(`\n📄 Get Job Results\n`);
      jobId = await this.cli.question('Enter job ID: ');
      if (!jobId.trim()) {
        console.log('❌ Job ID is required');
        return;
      }
      jobId = jobId.trim();
    }

    try {
      const loader = new LoadingIndicator();
      loader.start('📄 Fetching transcription results...', 'wave', '\x1b[32m');
      
      const response = await fetch(`${this.baseUrl}/result?job_id=${jobId}`);
      const result = await response.json();
      
      loader.stop();

      if (!response.ok) {
        if (result.error === 'Not ready') {
          console.log(`⏳ Job not ready yet. Status: ${result.status}, Progress: ${result.progress}%`);
          const monitor = await this.cli.question('Monitor progress? (y/N): ');
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
          
          // Handle cases where text might be undefined/null (failed chunks)
          if (partial.text) {
            console.log(`  Text: ${partial.text.substring(0, 100)}${partial.text.length > 100 ? '...' : ''}`);
          } else {
            console.log(`  Text: [Chunk processing failed - no transcript available]`);
          }
          
          if (partial.segments && partial.segments.length > 0) {
            console.log(`  Segments: ${partial.segments.length}`);
            console.log(`  Duration: ${partial.segments[0].start}s - ${partial.segments[partial.segments.length - 1].end}s`);
          }
        }
      }

      // Ask to save results
      const save = await this.cli.question('\nSave transcript to file? (Y/n): ');
      if (save.trim() === '' || save.toLowerCase().startsWith('y')) {
        const filename = await this.cli.question('Enter filename (default: transcript.txt): ');
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
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }

  async deleteJob() {
    console.log(`\n🗑️ Delete Job\n`);
    
    const jobId = await this.cli.question('Enter job ID to delete: ');
    if (!jobId.trim()) {
      console.log('❌ Job ID is required');
      return;
    }

    const confirm = await this.cli.question(`⚠️  Are you sure you want to delete job ${jobId.trim()}? This will remove the job and its files. (y/N): `);
    if (!confirm.toLowerCase().startsWith('y')) {
      console.log('❌ Deletion cancelled');
      return;
    }

    try {
      const loader = new LoadingIndicator();
      loader.start('🗑️ Deleting job and cleaning up files...', 'box', '\x1b[31m');
      
      const response = await fetch(`${this.baseUrl}/delete-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId.trim() })
      });

      const result = await response.json();
      loader.stop();

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
      if (typeof loader !== 'undefined') loader.stop();
      console.log(`❌ Error: ${error.message}`);
    }
  }
} 