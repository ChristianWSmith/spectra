<script>
  import { onMount } from 'svelte';
  import { AppService } from '../bindings/github.com/ChristianWSmith/wails-template';

  let version = $state('…');

  onMount(() => {
    AppService.GetVersion()
      .then((v) => (version = v))
      .catch(console.error);

    // Report the window size to Go (debounced) whenever the user resizes,
    // so the next launch can restore it. See prefs.go on the Go side.
    let timer;
    const report = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        AppService.SaveWindowSize(window.innerWidth, window.innerHeight).catch(
          console.error,
        );
      }, 500);
    };
    window.addEventListener('resize', report);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', report);
    };
  });
</script>

<main>
  <h1>Hello, Wails!</h1>
  <p class="version">Version {version}</p>
</main>
