<script>
  import { onMount } from 'svelte';
  import { loadStreamingJobsFromStorage } from './lib/stores.js';
  import Header from './components/Header.svelte';
  import UploadSection from './components/UploadSection.svelte';
  import JobsSection from './components/JobsSection.svelte';
  import Footer from './components/Footer.svelte';
  import { fetchJobs } from './lib/api.js';

  onMount(() => {
    loadStreamingJobsFromStorage();
    fetchJobs();
  });
</script>

<main class="max-w-6xl mx-auto p-5">
  <Header />
  <UploadSection />
  <JobsSection />
  <Footer />
</main> 