import { applyLLMCorrection } from '../../core/streaming.js';
import { processingLogger } from '../../core/logger.js';

/**
 * Chunk Assembly Logic for Chunked Upload Streaming
 * Handles intelligent assembly of chunk results into final transcripts
 */

export class ChunkAssembler {
  constructor(env) {
    this.env = env;
  }

  /**
   * Assemble chunks into final transcript with intelligent merging
   */
  async assembleChunks(parentJob, streamController = null) {
    const { transcripts, use_llm, llm_mode } = parentJob;
    
    processingLogger.processing('Starting chunk assembly', {
      parent_job_id: parentJob.job_id,
      total_chunks: transcripts.length,
      completed_chunks: this.getCompletedChunkCount(transcripts),
      llm_mode: use_llm ? llm_mode : 'disabled'
    });

    if (streamController) {
      this.sendStreamEvent(streamController, 'assembly_start', {
        parent_job_id: parentJob.job_id,
        total_chunks: transcripts.length,
        completed_chunks: this.getCompletedChunkCount(transcripts)
      });
    }

    // Get ordered, valid chunks
    const validChunks = this.getValidChunks(transcripts);
    
    if (validChunks.length === 0) {
      throw new Error('No valid chunks found for assembly');
    }

    // Assemble raw transcript
    const rawTranscript = this.assembleRawTranscript(validChunks);
    
    // Assemble corrected transcript (if per-chunk LLM was used)
    const correctedTranscript = this.assembleCorrectedTranscript(validChunks, use_llm, llm_mode);

    let finalTranscript = rawTranscript;

    // Apply post-processing LLM correction if requested
    if (use_llm && llm_mode === 'post_process') {
      if (streamController) {
        this.sendStreamEvent(streamController, 'llm_processing', {
          parent_job_id: parentJob.job_id,
          message: 'Applying LLM corrections to assembled transcript...',
          mode: 'post_process'
        });
      }

      try {
        finalTranscript = await applyLLMCorrection(rawTranscript, this.env.GROQ_API_KEY);
        
        if (streamController) {
          this.sendStreamEvent(streamController, 'llm_done', {
            parent_job_id: parentJob.job_id,
            corrected_text: finalTranscript,
            mode: 'post_process'
          });
        }

        processingLogger.llm('Applied post-processing LLM correction', {
          parent_job_id: parentJob.job_id,
          original_length: rawTranscript.length,
          corrected_length: finalTranscript.length
        });

      } catch (error) {
        processingLogger.error('Post-processing LLM correction failed', error, {
          parent_job_id: parentJob.job_id
        });

        if (streamController) {
          this.sendStreamEvent(streamController, 'llm_error', {
            parent_job_id: parentJob.job_id,
            error: error.message,
            fallback_text: rawTranscript,
            mode: 'post_process'
          });
        }

        // Use raw transcript as fallback
        finalTranscript = rawTranscript;
      }
    } else if (use_llm && llm_mode === 'per_chunk' && correctedTranscript) {
      // Use per-chunk corrected transcript
      finalTranscript = correctedTranscript;
    }

    const assembledResults = {
      final_transcript: finalTranscript,
      raw_transcript: rawTranscript,
      corrected_transcript: use_llm && llm_mode === 'per_chunk' ? correctedTranscript : null,
      total_chunks: transcripts.length,
      successful_chunks: validChunks.length,
      failed_chunks: transcripts.length - validChunks.length,
      assembly_method: this.getAssemblyMethod(validChunks),
      processing_stats: this.calculateProcessingStats(validChunks)
    };

    if (streamController) {
      this.sendStreamEvent(streamController, 'assembly_complete', {
        parent_job_id: parentJob.job_id,
        ...assembledResults
      });
    }

    processingLogger.complete('Chunk assembly completed', {
      parent_job_id: parentJob.job_id,
      successful_chunks: validChunks.length,
      failed_chunks: transcripts.length - validChunks.length,
      final_transcript_length: finalTranscript.length,
      assembly_method: assembledResults.assembly_method
    });

    return assembledResults;
  }

  /**
   * Get valid, non-failed chunks in order
   */
  getValidChunks(transcripts) {
    const validChunks = [];
    
    for (let i = 0; i < transcripts.length; i++) {
      const chunk = transcripts[i];
      
      // Consider chunks valid if they:
      // 1. Exist and didn't fail
      // 2. Have transcribed text OR are intentionally skipped (like chunk 0 metadata)
      if (chunk && !chunk.failed && (chunk.text || chunk.skipped)) {
        validChunks.push({
          ...chunk,
          original_index: i,
          // Ensure text is always a string (empty for skipped chunks)
          text: chunk.text || '',
          // Mark skipped chunks for special handling
          is_skipped: chunk.skipped === true
        });
      }
    }
    
    return validChunks.sort((a, b) => a.chunk_index - b.chunk_index);
  }

  /**
   * Assemble raw transcript from chunks
   */
  assembleRawTranscript(validChunks) {
    if (validChunks.length === 0) return '';
    
    // Filter out skipped chunks for transcript assembly but include them in processing
    const chunksWithText = validChunks.filter(chunk => !chunk.is_skipped && chunk.text);
    
    if (chunksWithText.length === 0) {
      // All chunks were skipped - return informative message
      return '[All audio chunks were skipped - likely file contains only metadata/headers]';
    }
    
    // Use intelligent merging to handle overlaps
    return this.intelligentMerge(chunksWithText.map(chunk => chunk.raw_text || chunk.text));
  }

  /**
   * Assemble corrected transcript (if per-chunk LLM was used)
   */
  assembleCorrectedTranscript(validChunks, use_llm, llm_mode) {
    if (!use_llm || llm_mode !== 'per_chunk') return null;
    
    // Filter out skipped chunks for transcript assembly
    const chunksWithText = validChunks.filter(chunk => !chunk.is_skipped && chunk.text);
    
    if (chunksWithText.length === 0) {
      return '[All audio chunks were skipped - no LLM correction applied]';
    }
    
    const correctedTexts = chunksWithText.map(chunk => chunk.corrected_text || chunk.text);
    return this.intelligentMerge(correctedTexts);
  }

  /**
   * Intelligent merge that handles overlaps and transitions between chunks
   */
  intelligentMerge(textArray) {
    if (textArray.length === 0) return '';
    if (textArray.length === 1) return textArray[0] || '';
    
    let merged = textArray[0] || '';
    
    for (let i = 1; i < textArray.length; i++) {
      const currentText = textArray[i] || '';
      if (!currentText) continue;
      
      // Try to find overlap between end of merged and start of current
      const overlap = this.findOverlap(merged, currentText);
      
      if (overlap.length > 0) {
        // Remove overlap from current text and merge
        const remainingText = currentText.substring(overlap.length);
        merged += (remainingText ? ' ' + remainingText : '');
      } else {
        // No overlap found, just join with space
        merged += ' ' + currentText;
      }
    }
    
    // Clean up extra spaces
    return merged.replace(/\s+/g, ' ').trim();
  }

  /**
   * Find overlap between end of first text and start of second text
   */
  findOverlap(text1, text2) {
    const words1 = text1.split(' ');
    const words2 = text2.split(' ');
    
    // Look for overlap of 1-5 words
    const maxOverlap = Math.min(5, words1.length, words2.length);
    
    for (let overlapLength = maxOverlap; overlapLength >= 1; overlapLength--) {
      const endWords = words1.slice(-overlapLength).join(' ');
      const startWords = words2.slice(0, overlapLength).join(' ');
      
      // Case-insensitive comparison
      if (endWords.toLowerCase() === startWords.toLowerCase()) {
        return words2.slice(0, overlapLength).join(' ');
      }
    }
    
    return '';
  }

  /**
   * Streaming assembly - provide partial results as chunks complete
   */
  getStreamingAssembly(transcripts, lastAssembledIndex = -1) {
    const validChunks = this.getValidChunks(transcripts);
    
    // Only process newly completed chunks
    const newChunks = validChunks.filter(chunk => chunk.chunk_index > lastAssembledIndex);
    
    if (newChunks.length === 0) {
      return {
        hasNewContent: false,
        partialTranscript: '',
        lastIndex: lastAssembledIndex
      };
    }

    // Get chunks up to the highest contiguous index
    const contiguousChunks = this.getContiguousChunks(validChunks);
    const partialTranscript = this.assembleRawTranscript(contiguousChunks);
    
    return {
      hasNewContent: true,
      partialTranscript,
      lastIndex: contiguousChunks.length > 0 ? contiguousChunks[contiguousChunks.length - 1].chunk_index : lastAssembledIndex,
      availableChunks: contiguousChunks.length,
      totalChunks: transcripts.length
    };
  }

  /**
   * Get chunks that form a contiguous sequence from the beginning
   */
  getContiguousChunks(validChunks) {
    if (validChunks.length === 0) return [];
    
    const sortedChunks = validChunks.sort((a, b) => a.chunk_index - b.chunk_index);
    const contiguous = [];
    
    let expectedIndex = 0;
    for (const chunk of sortedChunks) {
      if (chunk.chunk_index === expectedIndex) {
        contiguous.push(chunk);
        expectedIndex++;
      } else {
        break; // Stop at first gap
      }
    }
    
    return contiguous;
  }

  /**
   * Calculate processing statistics
   */
  calculateProcessingStats(validChunks) {
    if (validChunks.length === 0) {
      return {
        total_processing_time: 0,
        average_processing_time: 0,
        min_processing_time: 0,
        max_processing_time: 0,
        total_transcript_length: 0,
        average_chunk_length: 0
      };
    }

    const processingTimes = validChunks
      .map(chunk => chunk.processing_time || 0)
      .filter(time => time > 0);

    const transcriptLengths = validChunks
      .map(chunk => (chunk.text || '').length);

    return {
      total_processing_time: processingTimes.reduce((sum, time) => sum + time, 0),
      average_processing_time: processingTimes.length > 0 ? 
        Math.round(processingTimes.reduce((sum, time) => sum + time, 0) / processingTimes.length) : 0,
      min_processing_time: processingTimes.length > 0 ? Math.min(...processingTimes) : 0,
      max_processing_time: processingTimes.length > 0 ? Math.max(...processingTimes) : 0,
      total_transcript_length: transcriptLengths.reduce((sum, length) => sum + length, 0),
      average_chunk_length: transcriptLengths.length > 0 ? 
        Math.round(transcriptLengths.reduce((sum, length) => sum + length, 0) / transcriptLengths.length) : 0
    };
  }

  /**
   * Determine assembly method used
   */
  getAssemblyMethod(validChunks) {
    if (validChunks.length === 0) return 'none';
    if (validChunks.length === 1) return 'single_chunk';
    
    // Check if we had to handle gaps
    const sortedChunks = validChunks.sort((a, b) => a.chunk_index - b.chunk_index);
    let hasGaps = false;
    
    for (let i = 1; i < sortedChunks.length; i++) {
      if (sortedChunks[i].chunk_index !== sortedChunks[i-1].chunk_index + 1) {
        hasGaps = true;
        break;
      }
    }
    
    return hasGaps ? 'intelligent_merge_with_gaps' : 'intelligent_merge_sequential';
  }

  /**
   * Get count of completed (non-failed) chunks
   */
  getCompletedChunkCount(transcripts) {
    return transcripts.filter(chunk => chunk && !chunk.failed && chunk.text).length;
  }

  /**
   * Streaming event helper
   */
  sendStreamEvent(controller, type, data) {
    if (controller) {
      const eventData = `data: ${JSON.stringify({ type, ...data })}\n\n`;
      controller.enqueue(new TextEncoder().encode(eventData));
    }
  }

  /**
   * Validate assembly results
   */
  validateAssembly(assembledResults, parentJob) {
    const issues = [];

    // Check for empty transcript
    if (!assembledResults.final_transcript || assembledResults.final_transcript.trim().length === 0) {
      issues.push('Final transcript is empty');
    }

    // Check success rate
    const successRate = parentJob.total_chunks > 0 ? 
      (assembledResults.successful_chunks / parentJob.total_chunks) * 100 : 0;
    
    if (successRate < 50) {
      issues.push(`Low success rate: ${successRate.toFixed(1)}%`);
    }

    // Check for significant length differences (potential issues)
    if (assembledResults.raw_transcript && assembledResults.final_transcript) {
      const lengthDiff = Math.abs(
        assembledResults.final_transcript.length - assembledResults.raw_transcript.length
      ) / assembledResults.raw_transcript.length;
      
      if (lengthDiff > 0.5) { // 50% difference
        issues.push(`Significant length difference between raw and final transcript: ${(lengthDiff * 100).toFixed(1)}%`);
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
      successRate
    };
  }
} 