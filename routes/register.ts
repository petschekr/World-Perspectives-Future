import * as common from "../common";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as neo4j from "neo4j";
import * as moment from "moment";

let postParser = bodyParser.json();
export let registerRouter = express.Router();

let authenticateCheck = common.authenticateMiddleware;
let registeredCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("You must be logged in to register");
		}
	}
	else if (response.locals.user.registered) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(409).send("You have already registered");
		}
	}
	else {
		next();
	}
};
registerRouter.use(authenticateCheck, registeredCheck);

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

registerRouter.route("/").get(async (request, response) => {
	try {
		let result = await common.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c"
		});
		let registrationOpen: boolean = result[0].c.properties.registrationOpen;
		if (registrationOpen) {
			response.send(await common.readFileAsync("pages/register.html"));
		}
		else {
			response.send(await common.readFileAsync("pages/registrationclosed.html"));
		}
	}
	catch (err) {
		common.handleError(response, err);
	}
});
registerRouter.route("/sessions").get(async (request, response) => {
    try {
		let results: any[] = await common.cypherAsync({
			query: "MATCH (item:ScheduleItem {editable: true}) RETURN item.title AS title, item.start AS start, item.end AS end ORDER BY item.start"
		});
		results = results.map(function (item) {
			return {
				"title": item.title,
				"start": {
					"raw": item.start,
					"formatted": moment(item.start).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.start)}`
				},
				"end": {
					"raw": item.end,
					"formatted": moment(item.end).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.end)}`
				}
			};
		});
		response.json(results);
	}
	catch (err) {
		common.handleError(response, err);
	}
});
registerRouter.route("/sessions/:time")
	.get(async (request, response) => {
		let startTime = request.params.time;
		try {
			let results: any[] = await common.cypherAsync({
				query: `MATCH (s:Session {startTime: { startTime }}) RETURN
					s.title AS title,
					s.slug AS slug,
					s.description AS description,
					s.type AS type,
					s.location AS location,
					s.capacity AS capacity,
					s.attendees AS attendees,
					s.startTime AS startTime,
					s.endTime AS endTime
					ORDER BY lower(s.title)`,
				params: {
					startTime: startTime
				}
			});
			let sessions = await Promise.all(results.map(async session => {
				let sessionRelationships = await common.cypherAsync({
					queries: [{
						query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
						params: {
							slug: session.slug
						}
					}, {
						query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name",
						params: {
							slug: session.slug
						}
					}]
				});
				return {
					"title": {
						"formatted": session.title,
						"slug": session.slug
					},
					"description": session.description,
					"type": session.type,
					"location": session.location,
					"capacity": {
						"total": session.capacity,
						"filled": session.attendees
					},
					"time": {
						"start": {
							"raw": session.startTime,
							"formatted": moment(session.startTime).format(timeFormat)
						},
						"end": {
							"raw": session.endTime,
							"formatted": moment(session.endTime).format(timeFormat)
						},
						"date": moment(session.startTime).format(dateFormat)
					},
					"presenters": sessionRelationships[0],
					"moderator": (sessionRelationships[1].length !== 0) ? sessionRelationships[1][0] : null
				};
			}));
			response.json(sessions);
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.post(postParser, async (request, response) => {
		let {slug}: { slug: string } = request.body;
		let {time}: { time: string } = request.params;
		let intendedSession: any = null;
		let isOwn = false;
		// 1: Get this specific session and check for existance, time, and capacity
		// 2: Determine if this user presents a session at this time. If so, they must register for it.
		// 3: Determine if this user moderates a session at this time. If so, they must register for it.
		try {
			let [sessions, presentations, moderations, userFreeInfoRaw] = await Promise.all<any[], any[], any[], any[]>([
				common.cypherAsync({
					"query": "MATCH (s:Session {slug: {slug}, startTime: {time}}) RETURN s.startTime AS start, s.capacity AS capacity, s.attendees AS attendees",
					"params": {
						slug: slug,
						time: time
					}
				}),
				common.cypherAsync({
					"query": "MATCH (user:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {time}}) RETURN s.slug AS slug, s.title AS title",
					"params": {
						username: response.locals.user.username,
						time: time
					}
				}),
				common.cypherAsync({
					"query": "MATCH (user:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {time}}) RETURN s.slug AS slug, s.title AS title",
					"params": {
						username: response.locals.user.username,
						time: time
					}
				}),
				common.cypherAsync({
					query: "MATCH (user:User {username: {username}}) RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree",
					params: {
						username: response.locals.user.username
					}
				})
			]);
			let userFreeInfo = userFreeInfoRaw[0];
			if (presentations.length > 0 && presentations[0].slug !== slug) {
				response.json({ "success": false, "message": `You must select the session that you are presenting during this time period: "${presentations[0].title}"` });
				return;
			}
			if (moderations.length > 0 && moderations[0].slug !== slug) {
				response.json({ "success": false, "message": `You must select the session that you are moderating during this time period: "${moderations[0].title}"` });
				return;
			}
			if ((presentations.length > 0 && presentations[0].slug === slug) || (moderations.length > 0 && moderations[0].slug === slug)) {
				isOwn = true;
			}

			if (slug !== "free") {
				if (sessions.length !== 1) {
					response.json({ "success": false, "message": "Invalid session ID" });
					return;
				}
				let session = sessions[0];
				intendedSession = session;
				if (session.start !== time) {
					response.json({ "success": false, "message": "Session has mismatching start time" });
					return;
				}
				if (session.attendees >= session.capacity && !isOwn) {
					response.json({ "success": false, "message": "There are too many people in that session. Please choose another." });
					return;
				}
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree === time) {
					await common.cypherAsync({
						"query": "MATCH (user:User {username: {username}}) REMOVE user.hasFree, user.timeOfFree",
						"params": {
							username: response.locals.user.username
						}
					});
				}
			}
			else {
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree !== time) {
					response.json({ "success": false, "message": "You may select only one free" });
					return;
				}
			}
			
			// Now check if deregistration needs to happen and remove the relationship and decrement the number of attendees (the user selected a different session previously and has changed their mind)
			let results: {slug: string, attendees: number}[] = await common.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session {startTime: {time}}) SET s.attendees = s.attendees - 1 DELETE r RETURN s.slug AS slug, s.attendees AS attendees",
				"params": {
					username: response.locals.user.username,
					time: time
				}
			});
			// Notify via WebSocket of newly available spaces
			results.forEach(function (deletedSession) {
				common.io.emit("availability", {
					"slug": deletedSession.slug,
					"attendees": deletedSession.attendees
				});
			});
			if (isOwn) {
				// The attendance isn't increased if the user is a presenter or moderator of the selected session
				await common.cypherAsync({
					query: `
							MATCH (user:User {username: {username}})
							MATCH (session:Session {slug: {slug}})
							CREATE (user)-[r:ATTENDS]->(session)`,
					params: {
						username: response.locals.user.username,
						slug: slug
					}
				});
			}
			else {
				if (intendedSession !== null) {
					// Notify via WebSocket of the intention to register
					common.io.emit("availability", {
						"slug": slug,
						"attendees": intendedSession.attendees + 1
					});
					await common.cypherAsync({
						query: `
								MATCH (user:User {username: {username}})
								MATCH (session:Session {slug: {slug}})
								CREATE (user)-[r:ATTENDS]->(session)
								SET session.attendees = session.attendees + 1`,
						params: {
							username: response.locals.user.username,
							slug: slug
						}
					});
				}
				else {
					// Register for a free
					await common.cypherAsync({
						query: "MATCH (user:User {username: {username}}) SET user.hasFree = true, user.timeOfFree = {time}",
						params: {
							username: response.locals.user.username,
							time: time
						}
					});
				}
			}
			response.json({ "success": true, "message": "Successfully registered for session" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});

registerRouter.route("/done").post(async (request, response) => {
	// 1: Get all registered sessions
	// 2: Get the number of editable periods to ensure that all have been customized
	// 3: Get the user's free period data
	try {
		let [results, periodsRaw, userFreeInfoRaw] = await Promise.all<any[], any[], any[]>([
			common.cypherAsync({
				"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.type AS type",
				"params": {
					username: response.locals.user.username
				}
			}),
			common.cypherAsync({
				"query": "MATCH (item:ScheduleItem {editable: true}) RETURN count(item) AS periods",
			}),
			common.cypherAsync({
				query: "MATCH (user:User {username: {username}}) RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree",
				params: {
					username: response.locals.user.username
				}
			})
		]);
		let periods: number = periodsRaw[0].periods;
		let userFreeInfo = userFreeInfoRaw[0];
		let hasSelectedPanel = false;
		let hasSelectedSession = false;
		for (let result of results) {
			if (result.type === "Global session" || result.type === "Science session") {
				hasSelectedSession = true;
				continue;
			}
			if (result.type === "Panel") {
				hasSelectedPanel = true;
				continue;
			}
		}
		if (!hasSelectedPanel) {
			response.json({ "success": false, "message": "You must select at least one panel" });
			return;
		}
		if (!hasSelectedSession) {
			response.json({ "success": false, "message": "You must select at least one global studies or science session" });
			return;
		}
		if (userFreeInfo.hasFree) {
			periods--;
		}
		if (results.length < periods) {
			response.json({ "success": false, "message": "Your registration isn't yet completed" });
			return;
		}

		await common.cypherAsync({
			"query": "MATCH (user:User {username: {username}}) SET user.registered = true",
			"params": {
				username: response.locals.user.username
			}
		});
		response.json({ "success": true, "message": "Registration completed successfully" });
	}
	catch (err) {
		common.handleError(response, err);
	}
});
