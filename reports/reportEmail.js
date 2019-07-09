import Report from "./report";
import brembo from "brembo";
import fs from "fs";
import moment from "moment";
import nodemailer from "nodemailer";
import path from "path";

export default class ReportEmail extends Report {

    constructor(channels,params, env) {
        super(channels, params, env);

        this.templates = {};
        this.emailBacklog = [];

        this.transporter = nodemailer.createTransport({
            host: this.params.smtp,
            port: this.params.port,
            secure: this.params.useTls,
            ignoreTLS: this.params.ignoreTLS,
            auth: {
                user: this.params.user,
                pass: this.params.password,
                type: this.params.authType
            },
            tls: {
                rejectUnauthorizedCertificate: this.params.rejectUnauthorizedCertificate
            }
        });

        for (let channel of channels) {
            try {
                const file = path.resolve('reports/email_templates', `${channel}.txt`);
                this.templates[channel] = fs.readFileSync(file, "utf8");
            } catch (error){
                this.logger.log({
                    level: 'error',
                    message: channel + ' template cannot be loaded'
                })
            }
        }

        setInterval(() => {
            const nextEmail = this.emailBacklog.pop();
            if (nextEmail) {
                this._sendEmail(nextEmail);
            }
        }, 3000);
    }

    getEmails = (content) => {
        const users = content.data
            .map(item => {
                if (item.matchedRule && item.matchedRule.user){
                    return item.matchedRule.user;
                } else {
                    return false;
                }
            })
            .filter(item => !!item);

        try {
            return [...new Set(users)]
                .map(user => {
                    return this.params.notifiedEmails[user];
                });
        } catch (error) {
            this.logger.log({
                level: 'error',
                message: 'Not all users have an associated email address'
            });
        }

        return [];
    };

    _getBGPlayLink = (prefix, start, end, instant = null, rrcs = [0,1,2,5,6,7,10,11,13,14,15,16,18,20]) => {
        const bgplayTimeOffset = 5 * 60; // 5 minutes
        return brembo.build("https://stat.ripe.net/", {
            path: ["widget", "bgplay"],
            params: {
                "w.resource": prefix,
                "w.ignoreReannouncements": true,
                "w.starttime": moment(start).utc().unix() - bgplayTimeOffset,
                "w.endtime": moment(end).utc().unix(),
                "w.rrcs": rrcs.join(","),
                "w.instant": null,
                "w.type": "bgp",

            }
        }).replace("?", "#");
    };

    getEmailText = (channel, content) => {
        let context = {
            summary: content.message,
            earliest: moment(content.earliest).utc().format("YYYY-MM-DD hh:mm:ss"),
            latest: moment(content.latest).utc().format("YYYY-MM-DD hh:mm:ss"),
            channel,
            type: content.origin,
        };

        let matched = null;

        switch(channel){
            case "hijack":
                matched = content.data[0].matchedRule;
                context.prefix = matched.prefix;
                context.description = matched.description;
                context.asn = matched.asn;
                context.peers = [...new Set(content.data.map(alert => alert.matchedMessage.peer))].length;
                context.neworigin = content.data[0].matchedMessage.originAs;
                context.newprefix = content.data[0].matchedMessage.prefix;
                context.bgplay = this._getBGPlayLink(matched.prefix, content.earliest, content.latest);
                break;

            case "visibility":
                matched = content.data[0].matchedRule;
                context.prefix = matched.prefix;
                context.description = matched.description;
                context.asn = matched.asn;
                context.peers = [...new Set(content.data.map(alert => alert.matchedMessage.peer))].length;
                context.bgplay = this._getBGPlayLink(matched.prefix, content.earliest, content.latest);
                break;

            case "newprefix":
                break;

        }

        return this.templates[channel].replace(/\${([^}]*)}/g, (r,k)=>context[k]);
    };

    _sendEmail = (email) => {
        if (this.transporter) {
            this.transporter
                .sendMail(email)
                .catch(error => {
                    this.logger.log({
                        level: 'error',
                        message: error
                    });
                })
        }
    };

    report = (channel, content) => {
        const emailGroups = this.getEmails(content);

        for (let emails of emailGroups) {

            const text = this.getEmailText(channel, content);

            this.emailBacklog.push({
                from: this.params.email,
                to: emails.join(', '),
                subject: 'BGP alert: ' + channel,
                text: text
            });

        }
    }
}