# Your first Cividian site brief

Open https://cividian-site-diligence-agent.vercel.app/app . No signup
is required for the guest workspace. Start with one Indiana property you
know, or use **Try a Muncie address** to fill a public example address.

1. **Find the site.** Enter an address and select **Find site**. Check the map
   and parcel warnings. An address
   match or nearby parcel remains unverified. A polygon is not a survey.
2. **Choose an objective.** Residential infill, mixed-use or adaptive reuse.
   Open **Adjust assumptions** when you have inputs to add. Cost, acquisition,
   rent and cap-rate inputs are optional. Open **Building & parking assumptions**
   or **More financial assumptions**
   to review the labeled defaults and enter only assumptions you know.
   Leave unknown costs and rents blank; zero means a known zero.
3. **Create site brief.** The report opens when the run finishes. Missing data
   remains visible. Open **Run details** for progress. When
   the header says evidence-only mode, you still get source records, scenario
   calculations and a rules-based investigation plan without AI interpretation.
4. **Review the brief.** Start with the overview for the screening
   result and three investigation priorities. Expand **Scenarios** to compare
   calculations and **Sources** to inspect records. The full ten-section
   brief expands below the overview. Scenario arithmetic is not a feasibility
   finding, valuation or investment recommendation.
5. **Keep a copy.** Download JSON or open the printable brief and save to PDF
   through your browser. The workspace displays when your guest access ends.

## Return, refresh, or remove

Use **Menu > Saved briefs** in the same browser before your session expires. Guest
sessions last up to 24 hours. Refresh updates evidence and labels changes by
cause; it does not run automatically. **New brief** starts another investigation.
Editing the address clears the displayed results so they cannot be mistaken
for evidence about the next site. Previous saved briefs remain in the list.

**Edit inputs** returns to setup. Changing an assumption preserves your last
saved brief and labels it as using previous inputs. Create a new brief to use
your edits. Evidence refresh is disabled while those edits are pending so it
cannot overwrite them. Opening and closing report details keeps your work. Blank values
display as **Unknown**; the JSON still records them as null, never zero.

Guest saved URLs require the original browser session. They are not share links.
Clearing cookies, switching browsers or waiting past expiry loses guest access.
When managed sign-in is enabled, account briefs can be reopened after signing
in on another device. Guest briefs do not move into your account; export them
before signing in. Export a copy for a teammate or for longer-term records.

**Remove** in Saved briefs deletes that brief's content from the app after
confirmation. It cannot delete copies you downloaded or processing already
performed by a provider. Guest storage expires with the session.

## Coverage and data handling

Public parcel coverage is strongest in Indiana. Outside that coverage, you
may supply a labeled lot-area assumption. Zoning and some city/context sources
are unavailable. Every source status and gap is shown in the evidence panel.

Site lookups go to the configured public-data providers. Inputs and saved
briefs are processed by this deployment. If you request AI interpretation,
a bounded evidence-and-assumption packet goes to Nebius for NVIDIA model
reasoning. Avoid personal or confidential information. Read **Help & privacy**
in the workspace and inspect each source's link before relying on its data.

## Tell us what happened

Use **Report an issue**. Describe your steps and the outcome, download the
report, review it, and send it to the person who invited you. Nothing is
sent automatically. Automatic diagnostic fields omit addresses, financial
inputs, cookies and credentials. Your description is included as entered.

Helpful early feedback: Did the site match? Which source gap stopped your
work? Were the assumptions understandable? Could you export and reopen the
brief? What decision did the investigation plan help you prepare for?

## Install and connect

Use **Menu > Install app** for device instructions. This is an installable web
app, with the same features as the browser version. It needs a connection to
retrieve sites and sources. The website's **What's new** section lists updates.

**Menu > Account & connections** opens sign-in and API key settings. If sign-in
is still being connected, use the guest workspace. Once enabled, create a key
for your own script or MCP client. Keep it secret and revoke it when you stop
using the connection. See `/developers` for endpoint and client instructions.
API/MCP connections use source records and rules-based priorities; no paid AI
calls are made through those connections.
