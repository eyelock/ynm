/**
 * Every ynm command, by id. oclif loads this map (the "explicit" discovery strategy in
 * package.json) instead of scanning the directory, so the release bundle, which has no
 * commands directory on disk, runs the same commands as the checkout.
 */
import Annotate from "./annotate.js";
import Client from "./client.js";
import Context from "./context.js";
import Doctor from "./doctor.js";
import Dream from "./dream.js";
import Export from "./export.js";
import Forget from "./forget.js";
import Hook from "./hook.js";
import Import from "./import.js";
import Init from "./init.js";
import List from "./list.js";
import Pin from "./pin.js";
import Promote from "./promote.js";
import Purge from "./purge.js";
import Recall from "./recall.js";
import Reindex from "./reindex.js";
import Remember from "./remember.js";
import Review from "./review.js";
import Serve from "./serve.js";
import Session from "./session.js";
import Status from "./status.js";
import Supersede from "./supersede.js";
import Sync from "./sync.js";
import Wiki from "./wiki.js";

export const COMMANDS = {
  annotate: Annotate,
  client: Client,
  context: Context,
  doctor: Doctor,
  dream: Dream,
  export: Export,
  forget: Forget,
  hook: Hook,
  import: Import,
  init: Init,
  list: List,
  pin: Pin,
  promote: Promote,
  purge: Purge,
  recall: Recall,
  reindex: Reindex,
  remember: Remember,
  review: Review,
  serve: Serve,
  session: Session,
  status: Status,
  supersede: Supersede,
  sync: Sync,
  wiki: Wiki,
};
