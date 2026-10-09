// Every mock site, in the order the index page lists them.
import type { Site } from "../server.js";
import { flights } from "./flights.js";
import { mail } from "./mail.js";
import { signupSite } from "./signup.js";

export const sites: Site[] = [flights, signupSite, mail];
