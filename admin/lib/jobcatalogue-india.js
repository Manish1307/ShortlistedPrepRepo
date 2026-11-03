'use strict';
// Indian (and India-hiring) employers whose careers board the app can read. Made by scripts/probe-companies.js: each
// one answered with jobs when it was probed (2026-11-03). Run the script again to refresh the list.
// Used to find an employer by name (a typed company, or one the AI names for the candidate); not fetched unless asked for.
const INDIA_COMPANIES = [
  { name: "Anthropic", url: "https://boards.greenhouse.io/anthropic", sector: "it" },   // 677 jobs, 5 in India
  { name: "Cars24", url: "https://jobs.smartrecruiters.com/Cars24", sector: "it" },   // 1 jobs, 1 in India
  { name: "Clootrack", url: "https://jobs.smartrecruiters.com/Clootrack", sector: "it" },   // 1 jobs, 1 in India
  { name: "Dozee", url: "https://jobs.lever.co/dozee", sector: "it" },   // 20 jobs, 17 in India
  { name: "Gainsight", url: "https://jobs.ashbyhq.com/gainsight", sector: "it" },   // 20 jobs, 4 in India
  { name: "Genpact India", url: "https://jobs.smartrecruiters.com/GenpactIndia", sector: "it" },   // 1 jobs, 1 in India
  { name: "Glance", url: "https://boards.greenhouse.io/glance", sector: "it" },   // 34 jobs, 21 in India
  { name: "InMobi", url: "https://boards.greenhouse.io/inmobi", sector: "it" },   // 82 jobs, 54 in India
  { name: "Instahyre", url: "https://jobs.smartrecruiters.com/Instahyre", sector: "it" },   // 3 jobs, 3 in India
  { name: "Lendingkart", url: "https://jobs.smartrecruiters.com/Lendingkart", sector: "it" },   // 1 jobs, 1 in India
  { name: "Mavenir", url: "https://mavenir.wd1.myworkdayjobs.com/Mavenir_Careers", sector: "it" },   // 15 jobs, 8 in India
  { name: "Narayana Health", url: "https://jobs.smartrecruiters.com/NarayanaHealth", sector: "pharma" },   // 2 jobs, 2 in India
  { name: "Newton School", url: "https://jobs.smartrecruiters.com/NewtonSchool", sector: "it" },   // 1 jobs, 1 in India
  { name: "NoBroker", url: "https://jobs.smartrecruiters.com/NoBroker", sector: "it" },   // 1 jobs, 1 in India
  { name: "Observe.AI", url: "https://boards.greenhouse.io/observeai", sector: "it" },   // 9 jobs, 5 in India
  { name: "OpenAI", url: "https://jobs.ashbyhq.com/openai", sector: "it" },   // 805 jobs, 6 in India
  { name: "Parallel Wireless", url: "https://jobs.lever.co/parallelwireless", sector: "it" },   // 49 jobs, 9 in India
  { name: "Pubmatic", url: "https://boards.greenhouse.io/pubmatic", sector: "it" },   // 77 jobs, 31 in India
  { name: "Sigmoid", url: "https://boards.greenhouse.io/sigmoid", sector: "it" },   // 43 jobs, 38 in India
  { name: "Statiq", url: "https://jobs.smartrecruiters.com/Statiq", sector: "manufacturing" },   // 1 jobs, 1 in India
  { name: "Sutherland", url: "https://jobs.smartrecruiters.com/Sutherland", sector: "it" },   // 437 jobs, 62 in India
  { name: "Tekion", url: "https://jobs.ashbyhq.com/tekion", sector: "it" },   // 90 jobs, 66 in India
  { name: "Thoughtworks", url: "https://boards.greenhouse.io/thoughtworks", sector: "it" },   // 46 jobs, 1 in India
  { name: "Turing", url: "https://boards.greenhouse.io/turing", sector: "it" },   // 40 jobs, 6 in India
  { name: "Turtlemint", url: "https://jobs.smartrecruiters.com/Turtlemint", sector: "it" },   // 1 jobs, 1 in India
  { name: "Unacademy", url: "https://jobs.smartrecruiters.com/Unacademy", sector: "it" },   // 3 jobs, 3 in India
  { name: "Veeva", url: "https://jobs.lever.co/veeva", sector: "pharma" },   // 862 jobs, 23 in India
  { name: "Wabtec", url: "https://jobs.smartrecruiters.com/Wabtec", sector: "manufacturing" },   // 774 jobs, 129 in India
  { name: "ZingHR", url: "https://jobs.smartrecruiters.com/ZingHR", sector: "it" },   // 1 jobs, 1 in India
];
module.exports = { INDIA_COMPANIES };
