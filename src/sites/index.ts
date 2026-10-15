// Every mock site, in the order the index page lists them.
import type { Site } from "../server.js";
import { bank } from "../gym/bank.js";
import { clinic } from "../gym/clinic.js";
import { desk } from "../gym/desk.js";
import { stay } from "../gym/stay.js";
import { flights } from "./flights.js";
import { mail } from "./mail.js";
import { shop } from "./shop.js";
import { signupSite } from "./signup.js";
import { user } from "./user.js";

/** The scored sites first, then the train-suite sites (TS2). */
export const sites: Site[] = [flights, signupSite, mail, shop, user, stay, bank, clinic, desk];
