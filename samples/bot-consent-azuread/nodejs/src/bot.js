// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const {
    TeamsActivityHandler,
    MemoryStorage,
    TurnContext,
    UserState,
    ActionTypes,
    MessageFactory,
    CardFactory,
} = require('botbuilder');

const msal = require("@azure/msal-node");
const axios = require("axios");
const { Blob } = require("buffer");

class EchoBot extends TeamsActivityHandler {

    userState = null;
    tokenAccessor = null;

    constructor() {
        super();

        const memoryStorage = new MemoryStorage();
        this.userState = new UserState(memoryStorage);
        this.tokenAccessor = this.userState.createProperty("accessToken");

        // this.onInstallationUpdate(async (context, next) => {
        //     // If the app was updated or uninstalled, clear the welcome message state for the current user
        //     if (context.activity.action == "add") {
        //         await context.sendActivity(`Hello ${context.activity.from.name}, I'm the consent bot. Ask me to 'get profile' and I'll try and make a connection to Graph to get some information about you. If I need consent, I'll walk you through the process, using a sign-in card, and a modal window.`);
        //     }
        //     await next();
        // });

        this.onMessage(async (context, next) => {
            TurnContext.removeRecipientMention(context.activity);
            const text = context.activity.text.trim().toLocaleLowerCase().replace(/[\s-]/g, "");

            const token = await this.tokenAccessor.get(context);

            let baseUrl = process.env.BaseUrl.trim();
            while(baseUrl.charAt(baseUrl.length-1)=="/") {
                baseUrl = baseUrl.substring(0,baseUrl.length-1);
            }

            switch (text) {
                case "hello": case "help":       

                    const card = CardFactory.heroCard(
                        "Hi, I'm the Azure AD Consent Bot!",
                        "I can get information about you from Graph API, and display it in a hero card. To do this, click Get Profile... Or if you want to provide Consent, click Provide Consent. If you click Get Profile, and consent isn't already in place, I'm smart enough to deal with this and I'll walk you through that process!",
                        null,
                        [
                            {
                                type: ActionTypes.Signin,
                                title: "Provide Admin Consent",
                                text: "Provide Admin Consent",
                                value: `${baseUrl}/LoginStart.html?appId=${process.env.MicrosoftAppId}`
                            },
                            {
                                type: ActionTypes.Signin,
                                title: "Provide User Consent",
                                text: "Provide User Consent",
                                value: `${baseUrl}/LoginStart.html?userConsent=true&appId=${process.env.MicrosoftAppId}`
                            },
                            {
                                type: ActionTypes.ImBack,
                                title: "Get My Profile (app permissions)",
                                text: "Get Profile - app",
                                value: "Get Profile - app",
                                displayText: "Get My Profile (app permissions)"
                            },
                            {
                                type: ActionTypes.ImBack,
                                title: "Get My Profile (delegated permissions)",
                                text: "Get Profile - delegated",
                                value: "Get Profile - delegated",
                                displayText: "Get My Profile (delegated permissions)"
                            }
                        ]);

                    await context.sendActivity(MessageFactory.attachment(card));
                    break;

                case "showaccesstoken":
                    if (!token) {
                        await this.signIn(context);
                        break;
                    }
                    
                    await context.sendActivity(`Here is the Delegated Permissions Access Token I have stored in User State for this user, that will be swapped for a Graph API access token when required: ${token}`)
                
                    break;

                case "signin":
                    await this.signIn(context);
                    break;
            
                case "getprofile":
                    await context.sendActivity(
                        MessageFactory.attachment(
                            CardFactory.heroCard(
                                "I can help with that!", 
                                "Do you want me to get your profile using an app permissions or a delegated permission token?", 
                                null, 
                                [
                                    {
                                        type: ActionTypes.ImBack,
                                        title: "Get My Profile (app permissions)",
                                        text: "Get Profile - app",
                                        value: "Get Profile - app",
                                        displayText: "Get My Profile (app permissions)"
                                    },
                                    {
                                        type: ActionTypes.ImBack,
                                        title: "Get My Profile (delegated permissions)",
                                        text: "Get Profile - delegated",
                                        value: "Get Profile - delegated",
                                        displayText: "Get My Profile (delegated permissions)"
                                    }
                                ])));
                    break;
                case "getprofileapp":
                    
                    const userAadId = context.activity.from.aadObjectId;
                    const tenantId = context.activity.channelData.tenant.id;

                    const appToken = await this.getTokenForApp(tenantId);

                    const requestOptions = {
                        headers: {
                            Authorization: `Bearer ${appToken.accessToken}`
                        }
                    };

                    try{
                        const meResponse = await axios.default.get(`https://graph.microsoft.com/v1.0/users/${userAadId}?$select=displayName,department,jobTitle,state,officeLocation`, requestOptions);
                        const image = await this.getImageUrl(baseUrl, appToken.accessToken, userAadId);
                        
                        await context.sendActivity(
                            MessageFactory.attachment(
                                this.getProfileAdaptiveCard(image, meResponse.data.displayName, "Cannot get presence with app token", meResponse.data.officeLocation, meResponse.data.jobTitle, meResponse.data.department)));
                    }
                    catch(e) {
                        switch (e.response.data.error.code) {
                            case "Authorization_RequestDenied":
                            case "Authorization_IdentityNotFound":
                                await context.sendActivity(`Here is the token I used for authentication with Graph API: ${appToken.accessToken}`);
                                await context.sendActivity("Unfortunately I couldn't pull information on your user via Graph API, as you need to provide consent. Please decode this token by visiting https://jwt.ms/ and review the roles claim. Let's use a sign-in card to get consent, and then try sending 'get profile' to me again please.");

                                await context.sendActivity(
                                    MessageFactory.attachment(
                                        CardFactory.signinCard("Consent Required!", `${baseUrl}/LoginStart.html?appId=${process.env.MicrosoftAppId}`, "Provide Consent")));

                                break;
                            case "ImageNotFound":
                                await context.sendActivity("I can't generate a profile card, as there is no profile image for this user. Please add an image for this user via the Office 365 profile screen and try again.");
                                break;
                        }
                    }

                    break;
                case "getprofiledelegated":
                    if (!token) {
                        await this.signIn(context);
                        break;
                    }
                    
                    try {
                        const tokenResult = await this.getOnBehalfOf(token);

                        const requestOptions = {
                            headers: {
                                Authorization: `Bearer ${tokenResult.accessToken}`
                            }
                        };

                        const meResponse = await axios.default.get("https://graph.microsoft.com/v1.0/me?$select=displayName,department,jobTitle,state,officeLocation", requestOptions);
                        const presenceResponse = await axios.default.get("https://graph.microsoft.com/v1.0/me/presence", requestOptions);

                        const image = await this.getImageUrl(baseUrl, tokenResult.accessToken);

                        await context.sendActivity(
                            MessageFactory.attachment(
                                this.getProfileAdaptiveCard(image, meResponse.data.displayName, presenceResponse.data.availability, meResponse.data.officeLocation, meResponse.data.jobTitle, meResponse.data.department)));

                    }
                    catch(e) {
                        if (e.errorCode === "invalid_grant" || e.errorCode === "invalid_resource") {
                            await context.sendActivity(
                                MessageFactory.attachment(
                                    CardFactory.heroCard(
                                        "User Consent Required", 
                                        `ERROR: ${e.errorCode}. I need you to provide Consent so I can make some calls to the Graph API to find out some information about you. Please click the button below to complete the Consent process...`,
                                        null,
                                        [
                                            {
                                                type: ActionTypes.Signin,
                                                title: "Provide User Consent",
                                                text: "Provide User Consent",
                                                value: `${baseUrl}/LoginStart.html?userConsent=true&appId=${process.env.MicrosoftAppId}`
                                            }
                                        ])));
                        }
                        else if (e.errorCode === "invalid_assertion" || e.errorCode === "invalid_jwt_token") {
                            await this.signIn(context);
                        }
                    }

                    break;
                default:
                    await context.sendActivity("Sorry, I didn't understand that, try sending 'hello' or 'help' to get started :)");
                    break;
            }

            await next();
        });
    }

    async getImageUrl(baseUrl, token, userId) {
        let image = "";
        try {

            const imageResponse = await axios.default.get(`https://graph.microsoft.com/v1.0/${userId ? `users/${userId}` : "me"}/photo/$value`, { headers: {Authorization: `Bearer ${token}`}, responseType: "arraybuffer"});
            
            image = "data:" + imageResponse.headers["content-type"] + ";base64," + Buffer.from(imageResponse.data, "binary").toString('base64');

        }
        catch(e) {
            image = `${baseUrl}/missing.jpg`;
        }

        return image;
    }

    async signIn(context) {
        await context.sendActivity(
            MessageFactory.attachment(
                CardFactory.oauthCard("AAD", "Sign-in!", "Sign-in!", null, {id:"showAccessToken"})));
    }

    async handleTeamsSigninTokenExchange(context, query) {
        if (context.activity.name === "signin/tokenExchange") {
            const token = context.activity.value.token;
            await this.tokenAccessor.set(context, token);
            await context.sendActivity("You have successfully signed in, and the bot has now saved your access token to user state. Please send your command again to try again.");
            return;
        }

        if (context.activity.name === "signin/verifyState") {
            if (context.activity.value.state === "AdminConsent") {
                const activity = MessageFactory.attachment(
                    CardFactory.heroCard(
                        "Admin Consent Successful", 
                        "Admin Consent was successful! Click Get Profile to test Graph API functionality now consent has been granted for all users in this tenant.",
                        null,
                        [
                            {
                                type: ActionTypes.ImBack,
                                title: "Get My Profile (app permissions)",
                                text: "Get Profile - app",
                                value: "Get Profile - app",
                                displayText: "Get My Profile (app permissions)"
                            },
                            {
                                type: ActionTypes.ImBack,
                                title: "Get My Profile (delegated permissions)",
                                text: "Get Profile - delegated",
                                value: "Get Profile - delegated",
                                displayText: "Get My Profile (delegated permissions)"
                            }
                        ]));
                activity.replyToId = context.activity.replyToId;
                await context.updateActivity(activity);
            }
            else if (context.activity.value.state === "UserConsent") {
                const activity = MessageFactory.attachment(
                    CardFactory.heroCard(
                        "User Consent Successful", 
                        "User Consent was successful! Click Get Profile to test Graph API functionality now consent has been granted for this user!",
                        null,
                        [
                            {
                                type: ActionTypes.ImBack,
                                title: "Get My Profile (delegated permissions)",
                                text: "Get Profile - delegated",
                                value: "Get Profile - delegated",
                                displayText: "Get My Profile (delegated permissions)"
                            }
                        ]));
                activity.replyToId = context.activity.replyToId;
                await context.updateActivity(activity);
            }
        }
    }

    async getTokenForApp(tenantId) {
        const cca = new msal.ConfidentialClientApplication({
            auth: {
                clientId: process.env.MicrosoftAppId,
                clientSecret: process.env.MicrosoftAppPassword,
                authority: `https://login.microsoftonline.com/${tenantId}`
            }
        });

        return await cca.acquireTokenByClientCredential({
            scopes: [".default"]
        });
    }

    async getOnBehalfOf(accessToken) {
        const cca = new msal.ConfidentialClientApplication({
            auth: {
                clientId: process.env.MicrosoftAppId,
                clientSecret: process.env.MicrosoftAppPassword
            }
        });

        return await cca.acquireTokenOnBehalfOf({
            oboAssertion: accessToken,
            scopes: ["https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Presence.Read"]
        });
    }

    getProfileAdaptiveCard(imageUrl, profileName, availability, officeLocation, jobTitle, department) {
        return CardFactory.adaptiveCard({
          type: "AdaptiveCard",
          body: [
            {
              type: "TextBlock",
              size: "Medium",
              weight: "Bolder",
              text: "My Profile",
            },
            {
              type: "ColumnSet",
              columns: [
                {
                  type: "Column",
                  items: [
                    {
                      size: "Small",
                      style: "Person",
                      type: "Image",
                      url: imageUrl,
                    },
                  ],
                  width: "auto",
                },
                {
                  type: "Column",
                  items: [
                    {
                      type: "TextBlock",
                      weight: "Bolder",
                      text: profileName,
                      wrap: true,
                    },
                    {
                      type: "TextBlock",
                      spacing: "None",
                      text: availability,
                      isSubtle: true,
                      wrap: true,
                    },
                  ],
                  width: "stretch",
                },
              ],
            },
            {
              type: "TextBlock",
              text: "This Profile Card was generated by making Graph API calls",
              wrap: true,
            },
            {
              type: "FactSet",
              facts: [
                {
                  title: "Office Location: ",
                  value: officeLocation,
                },
                {
                  title: "Job Title:",
                  value: jobTitle,
                },
                {
                  title: "Department:",
                  value: department,
                },
              ],
            },
          ],
          actions: [
            {
              type: "Action.Submit",
              title: "Show User (delegated) Access Token",
              data: {
                msteams: {
                  type: "messageBack",
                  text: "showAccessToken",
                },
              },
            },
          ],
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
        });
    }

    async run(context) {
        await super.run(context);
        await this.userState.saveChanges(context, false);
    }
}

module.exports = EchoBot;