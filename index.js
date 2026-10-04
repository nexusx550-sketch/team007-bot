try { await import('./runner.mjs'); } catch (error) {
 const safe = /^(Set TELEGRAM|TEAMBOARD_URL|A bot process|Active webhook:)/.test(error.message||'');
 console.error(safe ? error.message : 'Bot stopped. Check network access, configuration and writable DATA_DIR.');
 process.exitCode=1;
}
