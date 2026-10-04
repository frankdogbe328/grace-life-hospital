import { installSecretEntrances } from "./admin/secret.js";
import { Chat } from "./chat/chat.js";
import { initPage } from "./page.js";

initPage();
void new Chat().mount();
installSecretEntrances();
