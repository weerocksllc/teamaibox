// The host supplies appearance only; no identity or media access is inferred.
(() => {
  const query = new URLSearchParams(location.search);
  const theme = query.get('theme');
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
})();
