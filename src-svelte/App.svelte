<script>
  import { onMount } from 'svelte';

  import Header from './components/Header.svelte';
  import UploadSection from './components/UploadSection.svelte';
  import JobsSection from './components/JobsSection.svelte';
  import Footer from './components/Footer.svelte';
  import { fetchJobs } from './lib/api.js';

  onMount(() => {
    fetchJobs();
  });
</script>

<main class="max-w-6xl mx-auto p-5 bg-terminal-bg-light">
  <Header />
  <UploadSection />
  <JobsSection />
</main> 

<div class="mb-8">
  <Footer />
</div>