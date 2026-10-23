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
 * Employers outside IT, grouped by sector. The candidate picks a sector in AI Job search (or the AI picks it from the
 * resume) and these are the career sites that are read; the IT list above is used only for the "it" sector.
 * country: India narrows a global Workday site to India with the site's own filter.
 */
const SECTOR_COMPANIES = [
  { name: 'Corteva', url: 'https://corteva.wd5.myworkdayjobs.com/Corteva' }, { name: 'Pivot Bio', url: 'https://boards.greenhouse.io/pivotbio' },
  { name: 'Zoetis', url: 'https://zoetis.wd5.myworkdayjobs.com/zoetis' }, { name: 'Ginkgo Bioworks', url: 'https://boards.greenhouse.io/ginkgobioworks' },
  { name: 'Thermo Fisher Scientific', url: 'https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers' }, { name: 'Agilent', url: 'https://agilent.wd5.myworkdayjobs.com/Agilent_Careers', country: 'India' },
  { name: 'Illumina', url: 'https://illumina.wd1.myworkdayjobs.com/illumina-careers', country: 'India' }, { name: 'Danaher', url: 'https://danaher.wd1.myworkdayjobs.com/DanaherJobs', country: 'India' },
  { name: 'Roche', url: 'https://roche.wd3.myworkdayjobs.com/roche-ext' }, { name: 'Labcorp', url: 'https://labcorp.wd1.myworkdayjobs.com/External' },
  { name: 'IQVIA', url: 'https://iqvia.wd1.myworkdayjobs.com/IQVIA', country: 'India' }, { name: 'Novartis', url: 'https://novartis.wd3.myworkdayjobs.com/Novartis_Careers', country: 'India' },
  { name: 'Pfizer', url: 'https://pfizer.wd1.myworkdayjobs.com/PfizerCareers', country: 'India' }, { name: 'MSD', url: 'https://msd.wd5.myworkdayjobs.com/SearchJobs' },
  { name: 'Sanofi', url: 'https://sanofi.wd3.myworkdayjobs.com/SanofiCareers', country: 'India' }, { name: 'AstraZeneca', url: 'https://astrazeneca.wd3.myworkdayjobs.com/Careers' },
  { name: 'GSK', url: 'https://gsk.wd5.myworkdayjobs.com/GSKCareers', country: 'India' }, { name: 'Abbott', url: 'https://abbott.wd5.myworkdayjobs.com/abbottcareers', country: 'India' },
  { name: 'Medtronic', url: 'https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers', country: 'India' },
  { name: 'Unilever', url: 'https://unilever.wd3.myworkdayjobs.com/Unilever_Experienced_Professionals', country: 'India' }, { name: 'Mondelez', url: 'https://mdlz.wd3.myworkdayjobs.com/External', country: 'India' },
  { name: 'Mars', url: 'https://mars.wd3.myworkdayjobs.com/External' }, { name: 'Coca-Cola', url: 'https://coke.wd1.myworkdayjobs.com/coca-cola-careers' },
  { name: '3M', url: 'https://3m.wd1.myworkdayjobs.com/Search', country: 'India' }, { name: 'Shell', url: 'https://shell.wd3.myworkdayjobs.com/ShellCareers' },
  { name: 'Barclays', url: 'https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays' }, { name: 'BlackRock', url: 'https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional' },
];

/** The sectors a candidate can pick. companies: names from SECTOR_COMPANIES or the IT list (CATALOGUE). 'it' is the IT list itself. */
const SECTORS = [
  { id: 'it', label: 'IT, software & consulting', companies: null },
  { id: 'agri', label: 'Agriculture, seeds & agri-biotech', companies: ['Corteva', 'Pivot Bio', 'Zoetis', 'Ginkgo Bioworks', 'Thermo Fisher Scientific', 'Agilent', 'Mars'] },
  { id: 'biotech', label: 'Biotech, life sciences & research labs', companies: ['Thermo Fisher Scientific', 'Agilent', 'Illumina', 'Danaher', 'Ginkgo Bioworks', 'Roche', 'Labcorp', 'IQVIA', 'Corteva', 'Pfizer', 'Novartis'] },
  { id: 'pharma', label: 'Pharma, healthcare & medical devices', companies: ['Novartis', 'Pfizer', 'MSD', 'Sanofi', 'AstraZeneca', 'GSK', 'Roche', 'Abbott', 'Medtronic', 'Zoetis', 'IQVIA', 'Labcorp', 'Danaher'] },
  { id: 'fmcg', label: 'FMCG, food & beverages', companies: ['Unilever', 'Mondelez', 'Mars', 'Coca-Cola', 'Corteva'] },
  { id: 'manufacturing', label: 'Manufacturing, engineering & energy', companies: ['3M', 'Bosch', 'Baker Hughes', 'Avery Dennison', 'Shell', 'Danaher', 'Western Digital'] },
  { id: 'other', label: 'Other (the AI chooses employers from my resume)', companies: [] },
  { id: 'finance', label: 'Banking, finance & accounting', companies: ['Barclays', 'BlackRock', 'Citi', 'Wells Fargo', 'Mastercard', 'Visa', 'KPMG India', 'EY'] },
];

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

/** Each built-in company's own web address, for its logo next to its jobs. */
const DOMAINS = {
  Stripe: 'stripe.com', Databricks: 'databricks.com', Cloudflare: 'cloudflare.com', Twilio: 'twilio.com', Okta: 'okta.com', MongoDB: 'mongodb.com',
  Elastic: 'elastic.co', GitLab: 'gitlab.com', HubSpot: 'hubspot.com', Zscaler: 'zscaler.com', Rubrik: 'rubrik.com', 'New Relic': 'newrelic.com',
  Datadog: 'datadoghq.com', Coinbase: 'coinbase.com', Airbnb: 'airbnb.com', Dropbox: 'dropbox.com', Pinterest: 'pinterest.com', Chargebee: 'chargebee.com',
  Postman: 'postman.com', Druva: 'druva.com', ServiceTitan: 'servicetitan.com', Samsara: 'samsara.com', 'Pure Storage': 'purestorage.com', Nutanix: 'nutanix.com',
  Confluent: 'confluent.io', Celonis: 'celonis.com', PhonePe: 'phonepe.com', Groww: 'groww.in', Razorpay: 'razorpay.com', Sprinklr: 'sprinklr.com',
  Freshworks: 'freshworks.com', Mindtickle: 'mindtickle.com', Innovaccer: 'innovaccer.com', BrowserStack: 'browserstack.com', Palantir: 'palantir.com',
  CRED: 'cred.club', Zeta: 'zeta.tech', Meesho: 'meesho.com', Swiggy: 'swiggy.com', Paytm: 'paytm.com', Upstox: 'upstox.com', Dream11: 'dream11.com',
  ShareChat: 'sharechat.com', Atlan: 'atlan.com', Ramp: 'ramp.com', Notion: 'notion.so', Zepto: 'zeptonow.com', Deel: 'deel.com', Bosch: 'bosch.com',
  Visa: 'visa.com', ServiceNow: 'servicenow.com', Equinix: 'equinix.com', 'Western Digital': 'westerndigital.com', 'Avery Dennison': 'averydennison.com',
  Salesforce: 'salesforce.com', Adobe: 'adobe.com', NVIDIA: 'nvidia.com', Intel: 'intel.com', Dell: 'dell.com', HP: 'hp.com', Mastercard: 'mastercard.com',
  Walmart: 'walmart.com', Target: 'target.com', 'Wells Fargo': 'wellsfargo.com', Citi: 'citi.com', 'Baker Hughes': 'bakerhughes.com', Autodesk: 'autodesk.com',
  Workday: 'workday.com', Accenture: 'accenture.com', HCLTech: 'hcltech.com', Wipro: 'wipro.com', Capgemini: 'capgemini.com', EY: 'ey.com',
  Corteva: 'corteva.com', 'Pivot Bio': 'pivotbio.com', Zoetis: 'zoetis.com', 'Ginkgo Bioworks': 'ginkgobioworks.com', 'Thermo Fisher Scientific': 'thermofisher.com',
  Agilent: 'agilent.com', Illumina: 'illumina.com', Danaher: 'danaher.com', Roche: 'roche.com', Labcorp: 'labcorp.com', IQVIA: 'iqvia.com', Novartis: 'novartis.com',
  Pfizer: 'pfizer.com', MSD: 'msd.com', Sanofi: 'sanofi.com', AstraZeneca: 'astrazeneca.com', GSK: 'gsk.com', Abbott: 'abbott.com', Medtronic: 'medtronic.com',
  Unilever: 'unilever.com', Mondelez: 'mondelezinternational.com', Mars: 'mars.com', 'Coca-Cola': 'coca-colacompany.com', '3M': '3m.com', Shell: 'shell.com',
  Barclays: 'barclays.com', BlackRock: 'blackrock.com', LTIMindtree: 'ltimindtree.com', 'KPMG India': 'kpmg.com', Hexaware: 'hexaware.com', Zensar: 'zensar.com', Amazon: 'amazon.com',
};

// job-board systems: their address says nothing about the company
const BOARD_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|myworkdayjobs\.com|oraclecloud\.com|amazon\.jobs|workable\.com|recruitee\.com)$/i;

/** A company's web address for its logo: the built-in list, else the host of its own careers site; '' when unknown. */
function companyDomain(name, careersUrl) {
  const known = Object.keys(DOMAINS).find(k => k.toLowerCase() === String(name || '').trim().toLowerCase());
  if (known) return DOMAINS[known];
  let host = '';
  try { host = new URL(String(careersUrl || '')).hostname.toLowerCase(); } catch (_) { return ''; }
  if (!host || BOARD_HOSTS.test(host)) return '';
  return host.replace(/^(www|careers?|jobs|join|apply)\./, '');
}

module.exports = { CATALOGUE, SECTOR_COMPANIES, SECTORS, SEARCH_ELSEWHERE, DOMAINS, companyDomain };
