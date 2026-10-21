module.exports = {
  apps: [
    {
      name: 'Logiks_WebCMS',
      script: 'src/server.js',
      instances: '1',
      max_memory_restart: '1024M',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
