import auth from './auth/module.js';
import settings from './settings/module.js';
import users from './users/module.js';
import audit from './audit/module.js';
import cluster from './cluster/module.js';
import system from './system/module.js';
import updates from './updates/module.js';
import content from './content/module.js';
import media from './media/module.js';
import themes from './themes/module.js';
import search from './search/module.js';
import site from './site/module.js';
import services from './services/module.js';
import dbms from './dbms/module.js';
import seo from './seo/module.js';
import events from './events/module.js';
import webhooks from './webhooks/module.js';
import scheduler from './scheduler/module.js';
import sitemap from './sitemap/module.js';
import libraries from './libraries/module.js';
import analytics from './analytics/module.js';
import plugins from './plugins/module.js';
import pluginEditor from './plugin-editor/module.js';
import mediaGenerator from './media-generator/module.js';
import pageDesigner from './page-designer/module.js';
import assistant from './assistant/module.js';
import api from './api/module.js';

/**
 * Every built-in module, in the order their admin routers mount (the registry moves a module after what it
 * `requires`, nothing else). Adding a module = a `module.js` in its folder + one line here (D-067).
 */
export const builtinModules = [
  auth,
  settings,
  users,
  audit,
  cluster,
  system,
  updates,
  content,
  media,
  themes,
  search,
  site,
  services,
  dbms,
  seo,
  events,
  webhooks,
  scheduler,
  sitemap,
  libraries,
  analytics,
  plugins,
  pluginEditor,
  mediaGenerator,
  pageDesigner,
  assistant,
  api,
];
