# Design review: shortlistprep.com/index.html (4 Nov 2026)

Reviewed live, at 1440 px and 375 px, in the in-app browser (signed in as a test account, so the guest hero buttons were read from the source). No code was changed.

**Design score: B-** · **AI slop score: B** · Page: 12,065 px tall on a phone, 11 sections, 21 headings, 90 links and buttons, 29 requests, about 220 KB of images.

## First impression
- **The site says:** "a serious, friendly tool for Indian freshers", and the first screen delivers it: a plain-language headline ("Find out why you are not getting interview calls, and fix it."), a real-looking sample report on the right, one orange button.
- **The eye goes to:** (1) the serif headline, (2) the orange "Continue my journey" / "Check my resume free" button, (3) the ATS score "68 / 100" in the sample report. That is the intended order.
- **One word:** *credible*. The founder photo and name, the privacy and "no auto-renewal" lines, and the real job numbers do more for trust than any badge.

## What is working (keep it)
- **Typography is a real choice:** Source Serif 4 for headlines, Public Sans for text, a clear 52 / 42 / 36 / 19 px scale, body 16 px on a 1.6 line height. Not the generic system-font look.
- **The sample report** (ATS score, requirement match, "Do this next") shows the product in one glance.
- **The founder block** (photo, name, "20+ years in IT") is the strongest trust element on the page.
- **Honest money copy:** "Start free", "no card required", "paid passes never renew automatically", prices shown with the days they cover.
- **The new Jobs section** shows real jobs with company logos and live counts (30,302 jobs, 99 company career sites).
- **Technical basics are good:** no layout shift (CLS 0), `prefers-reduced-motion` respected, visible focus styles, alt text on every image, no sideways scroll on a phone.

## Findings (most important first)

### Trust
1. **[HIGH] The "20% / 25% / 20% / 35%" capability cards look invented.** "Here is how much of ShortlistPrep each covers" gives four arbitrary numbers with progress bars. A careful visitor will read them as made up. Replace with what each tool actually does (a number a user can check, or nothing).
2. **[HIGH] The footer says "X, LinkedIn and YouTube pages are coming soon."** Placeholder social links read as an unfinished company. Remove the sentence until the pages exist, then link them.
3. **[MEDIUM] No outside proof yet.** There are no reviews, outcomes or named users (the Reviews page is switched off, which is right while there are none). Use real, checkable numbers instead: resumes checked, jobs read, companies covered (the Jobs section already does this).
4. **[MEDIUM] The floating "15% Your journey" chip** shows "Agent, you have used 15% of our features." This is gamified pressure, it shows the wrong name for the test account, and it is an `h2`, which pollutes the page outline.
5. **[MEDIUM] Plan texts still say "AI job searches"** ("2 AI job searches a month", "About 30 AI job searches"). The product is now called Live Search. This is stored in the database, so edit it in the admin under Pricing.
6. **[POLISH] Small trust gaps:** no refund line next to the prices, no link to the founder's LinkedIn, no phone or WhatsApp number beside "Request a personal demo".

### Interactivity (what to add)
7. **[HIGH] Nothing on the home page reacts to the visitor.** The two big promises (ATS score, skill gaps) are shown as pictures. **Biggest win:** a resume drop-zone in the hero ("Drop your resume, see your ATS score in 10 seconds"), reusing the free ATS checker.
8. **[MEDIUM] The sample report is one fixed example (a Java developer).** Add small tabs (Java, Data, Civil, Electronics) so engineering and non-IT visitors see themselves.
9. **[MEDIUM] The Jobs card is static.** Add sector chips (IT, Pharma, Engineering, Finance…) that swap the three latest jobs, using the same filter the Jobs page has.
10. **[MEDIUM] The pricing cards have no buttons** and are not clickable. Each plan needs its own button, and a "Most popular" label on the plan you want people to choose.
11. **[MEDIUM] No answers to the usual doubts.** Add 5 short FAQ items next to pricing ("Do you keep my resume?", "Are the jobs real?", "What if I want a refund?").
12. **[POLISH] No sticky call to action on a phone.** After the hero scrolls away there is no button in sight for 10 screens.

### Layout and spacing
13. **[HIGH] The pricing grid is 820 px wide inside a 1,160 px column.** The three cards hug the left and leave the right quarter empty. The plan "Free" also shows the word "Free" twice (name and price).
14. **[MEDIUM] The "Book a free 1-on-1 session" band sits between the hero and the features,** so it interrupts the story before the visitor knows the product. Move it below the skill-gap or pricing section.
15. **[MEDIUM] The hero paragraph is 6 lines on a phone,** so the primary button starts below the fold. Cut it to two lines.
16. **[POLISH] Three headings in a row use the same visual weight** (the capability cards), so nothing leads. One card should be larger.

### Colour and contrast
17. **[HIGH] The orange primary button fails AA contrast** (white on orange is 3.7 : 1, needs 4.5 : 1 for text this size). It is on every key button: Continue my journey, Browse jobs, Pick a slot, Download. A slightly darker orange passes and still looks the same.
18. **[MEDIUM] 12 px grey labels** ("ATS score", "Requirement match", "Do this next") are too small and pale. Raise to 13 px or darken.

### Responsive
19. **[MEDIUM] The floating chip overlaps content on a phone** (it covers the right edge of the sample report). Make it dismissible and sit it above the bottom edge.
20. **[MEDIUM] Touch targets:** 14 elements are under 44 px tall on a phone (hamburger 41 × 34, text links 15 to 26 px, "Privacy policy" 17 px). Add padding.

### Performance
21. **[MEDIUM] First byte takes about 1.0 s** (the server), and 8 stylesheets load before the page draws. Merge the home-page CSS into fewer files; consider a CDN for static files.
22. **[POLISH] Fonts are not preloaded** (they swap, which is fine). `/api/strength` takes 0.86 s but only for signed-in users and does not block anything.

## Quick wins (each under 30 minutes)
1. Darken the primary orange so white text passes 4.5 : 1.
2. Pricing: full-width grid, fix "Free | Free", add a button per plan, "Most popular" on one plan.
3. Remove the "coming soon" sentence from the footer.
4. Replace the 20 / 25 / 20 / 35 % cards with plain facts.
5. Make the journey chip dismissible, move it off the content on a phone, and make its heading a `div`.
6. Shorten the hero paragraph; add a sticky "Check my resume free" bar on phones.
7. Edit the plan texts to say Live Search (admin → Pricing).

## Bigger interactive ideas, in order
1. Resume drop-zone in the hero with an instant ATS score.
2. Role tabs on the sample report (Java / Data / Civil / Electronics).
3. Sector chips on the Jobs card.
4. FAQ block next to pricing.
5. A 60-second video of the real product.

## Slop check
Clean on the big tells: no purple gradient hero, no stock-photo hero (a real founder photo instead), no fake testimonial row. Two mild ones: the **four big-number cards** (the template "three big numbers" pattern, see finding 1) and the **dark gradient pill** on the Jobs trust bar (fine, but it is the only gradient pill on the page).

## Not covered
- The guest view of the hero was not captured in the browser (the in-app browser was signed in, and I did not sign it out). The guest button text was read from the source: "Check my resume free".
- Other pages (Pricing, ATS checker, Jobs, Career toolkit) were not reviewed in depth here.
