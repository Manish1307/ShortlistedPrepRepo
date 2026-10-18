'use strict';
// Well-known companies whose careers sites have a public job list (see jobsources.js). AI Job search uses them
// when a candidate leaves "Companies" empty; candidates can also type any other company name or careers URL.

const CATALOGUE = [
  // Greenhouse
  ['Stripe', 'https://boards.greenhouse.io/stripe'], ['Databricks', 'https://boards.greenhouse.io/databricks'],
  ['Cloudflare', 'https://boards.greenhouse.io/cloudflare'], ['Twilio', 'https://boards.greenhouse.io/twilio'],
  ['Okta', 'https://boards.greenhouse.io/okta'], ['MongoDB', 'https://boards.greenhouse.io/mongodb'],
  ['Elastic', 'https://boards.greenhouse.io/elastic'], ['GitLab', 'https://boards.greenhouse.io/gitlab'],
  ['HubSpot', 'https://boards.greenhouse.io/hubspotjobs'], ['Zscaler', 'https://boards.greenhouse.io/zscaler'],
  ['Rubrik', 'https://boards.greenhouse.io/rubrik'], ['New Relic', 'https://boards.greenhouse.io/newrelic'],
  ['Datadog', 'https://boards.greenhouse.io/datadog'], ['Coinbase', 'https://boards.greenhouse.io/coinbase'],
  ['Airbnb', 'https://boards.greenhouse.io/airbnb'], ['Dropbox', 'https://boards.greenhouse.io/dropbox'],
  ['Pinterest', 'https://boards.greenhouse.io/pinterest'], ['Chargebee', 'https://boards.greenhouse.io/chargebee'],
  ['Postman', 'https://boards.greenhouse.io/postman'], ['Druva', 'https://boards.greenhouse.io/druva'],
  ['ServiceTitan', 'https://boards.greenhouse.io/servicetitan'], ['Samsara', 'https://boards.greenhouse.io/samsara'],
  ['Pure Storage', 'https://boards.greenhouse.io/purestorage'], ['Nutanix', 'https://boards.greenhouse.io/nutanix'],
  ['Confluent', 'https://boards.greenhouse.io/confluent'], ['Celonis', 'https://boards.greenhouse.io/celonis'],
  ['PhonePe', 'https://boards.greenhouse.io/phonepe'], ['Groww', 'https://boards.greenhouse.io/groww'],
  ['Razorpay', 'https://boards.greenhouse.io/razorpaysoftwareprivatelimited'], ['Sprinklr', 'https://boards.greenhouse.io/sprinklr'],
  ['Freshworks', 'https://boards.greenhouse.io/freshworks'], ['Mindtickle', 'https://boards.greenhouse.io/mindtickle'],
  ['Innovaccer', 'https://boards.greenhouse.io/innovaccer'], ['BrowserStack', 'https://boards.greenhouse.io/browserstack'],
  // Lever
  ['Palantir', 'https://jobs.lever.co/palantir'], ['CRED', 'https://jobs.lever.co/cred'], ['Zeta', 'https://jobs.lever.co/zeta'],
  ['Meesho', 'https://jobs.lever.co/meesho'], ['Swiggy', 'https://jobs.lever.co/swiggy'], ['Paytm', 'https://jobs.lever.co/paytm'],
  ['Upstox', 'https://jobs.lever.co/upstox'], ['Dream11', 'https://jobs.lever.co/dream11'], ['ShareChat', 'https://jobs.lever.co/sharechat'],
  ['Atlan', 'https://jobs.lever.co/atlan'],
  // Ashby
  ['Ramp', 'https://jobs.ashbyhq.com/ramp'], ['Notion', 'https://jobs.ashbyhq.com/notion'], ['Zepto', 'https://jobs.ashbyhq.com/zepto'],
  ['Deel', 'https://jobs.ashbyhq.com/deel'],
  // SmartRecruiters
  ['Bosch', 'https://careers.smartrecruiters.com/BoschGroup'], ['Visa', 'https://careers.smartrecruiters.com/Visa'],
  ['ServiceNow', 'https://careers.smartrecruiters.com/ServiceNow'], ['Equinix', 'https://careers.smartrecruiters.com/Equinix'],
  ['Western Digital', 'https://careers.smartrecruiters.com/WesternDigital'], ['Avery Dennison', 'https://careers.smartrecruiters.com/AveryDennison'],
  // Workday
  ['Salesforce', 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site'], ['Adobe', 'https://adobe.wd5.myworkdayjobs.com/external_experienced'],
  ['NVIDIA', 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'], ['Intel', 'https://intel.wd1.myworkdayjobs.com/External'],
  ['Dell', 'https://dell.wd1.myworkdayjobs.com/External'], ['HP', 'https://hp.wd5.myworkdayjobs.com/ExternalCareerSite'],
  ['Mastercard', 'https://mastercard.wd1.myworkdayjobs.com/CorporateCareers'], ['Walmart', 'https://walmart.wd5.myworkdayjobs.com/WalmartExternal'],
  ['Target', 'https://target.wd5.myworkdayjobs.com/targetcareers'], ['Wells Fargo', 'https://wellsfargo.wd1.myworkdayjobs.com/WellsFargoJobs'],
  ['Citi', 'https://citi.wd5.myworkdayjobs.com/2'], ['Baker Hughes', 'https://bakerhughes.wd5.myworkdayjobs.com/BakerHughes'],
  ['Autodesk', 'https://autodesk.wd1.myworkdayjobs.com/Ext'], ['Workday', 'https://workday.wd5.myworkdayjobs.com/Workday'],
].map(([name, url]) => ({ name, url })).concat([
  // Indian IT services firms and big employers in India (their sites list jobs worldwide: kept to India)
  { name: 'Accenture', url: 'https://accenture.wd103.myworkdayjobs.com/accenturecareers', country: 'India' },
  { name: 'HCLTech', url: 'https://careers.hcltech.com', board: { provider: 'sfunified', board: 'careers.hcltech.com', facets: { custCountryRegion: ['India'] } } },
  { name: 'Wipro', url: 'https://careers.wipro.com', board: { provider: 'sfunified', board: 'careers.wipro.com', location: 'India' } },
  { name: 'Capgemini', url: 'https://careers.capgemini.com' },
  { name: 'EY', url: 'https://careers.ey.com/ey', board: { provider: 'sfclassic', board: 'careers.ey.com/ey', location: 'India' } },
  { name: 'LTIMindtree', url: 'https://careers.ltm.com', board: { provider: 'sfclassic', board: 'careers.ltm.com' } },
  { name: 'KPMG India', url: 'https://ejgk.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' },
  { name: 'Hexaware', url: 'https://fa-etqo-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' },
  { name: 'Zensar', url: 'https://fa-etvl-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX' },
  { name: 'Amazon', url: 'https://www.amazon.jobs' },
]);

/**
 * Big employers whose careers sites cannot be read automatically: candidates get a link to search there, and on
 * Naukri and LinkedIn, next to the results. {name, url} with {q} for the role and {l} for the city or country.
 */
const SEARCH_ELSEWHERE = [
  { name: 'TCS', url: 'https://ibegin.tcs.com/iBegin/jobs/search' },
  { name: 'Infosys', url: 'https://career.infosys.com/joblist' },
  { name: 'Cognizant', url: 'https://careers.cognizant.com/global-en/jobs/' },
  { name: 'Tech Mahindra', url: 'https://careers.techmahindra.com/' },
  { name: 'Deloitte India', url: 'https://southasiacareers.deloitte.com/' },
  { name: 'Microsoft', url: 'https://jobs.careers.microsoft.com/global/en/search?q={q}&lc={l}' },
  { name: 'Google', url: 'https://www.google.com/about/careers/applications/jobs/results/?q={q}&location={l}' },
  { name: 'IBM', url: 'https://www.ibm.com/careers/search' },
  { name: 'Persistent', url: 'https://careers.persistent.com/' },
  { name: 'Mphasis', url: 'https://careers.mphasis.com/home.html' },
];

module.exports = { CATALOGUE, SEARCH_ELSEWHERE };
