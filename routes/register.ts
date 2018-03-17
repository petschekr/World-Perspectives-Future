import * as common from "../common";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as moment from "moment";
import * as neo4j from "neo4j-driver";

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
		let session = common.driver.session();
		let result = await session.run("MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c");
		session.close();

		let registrationOpen: boolean = result.records[0].get("c").properties.registrationOpen;
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
		let session = common.driver.session();
		let results = await session.run("MATCH (item:ScheduleItem {editable: true}) RETURN item.title AS title, item.start AS start, item.end AS end ORDER BY item.start");
		session.close();
		response.json(results.records.map(item => {
			return {
				"title": item.get("title"),
				"start": {
					"raw": item.get("start"),
					"formatted": moment(item.get("start")).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.get("start"))}`
				},
				"end": {
					"raw": item.get("end"),
					"formatted": moment(item.get("end")).format(timeFormat),
					"url": `/register/sessions/${encodeURIComponent(item.get("end"))}`
				}
			};
		}));
	}
	catch (err) {
		common.handleError(response, err);
	}
});
registerRouter.route("/sessions/:time")
	.get(async (request, response) => {
		let startTime = request.params.time;
		try {
			const dbSession = common.driver.session();
			let results = await dbSession.run(`MATCH (s:Session {startTime: { startTime }}) RETURN
					s.title AS title,
					s.slug AS slug,
					s.description AS description,
					s.type AS type,
					s.location AS location,
					s.capacity AS capacity,
					s.attendees AS attendees,
					s.startTime AS startTime,
					s.endTime AS endTime
					ORDER BY lower(s.title)`, { startTime });
			
			let sessions = await Promise.all(results.records.map(async session => {
				let sessionRelationships = await Promise.all([
					dbSession.run(`
						MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) 
						RETURN user.username AS username, user.name AS name 
						ORDER BY last(split(user.name, " "))
					`, { slug: session.get("slug") }),
					dbSession.run(`
						MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }})
						RETURN user.username AS username, user.name AS name
					`, { slug: session.get("slug") })
				]);
				return {
					"title": {
						"formatted": session.get("title"),
						"slug": session.get("slug")
					},
					"description": session.get("description"),
					"type": session.get("type"),
					"location": session.get("location"),
					"capacity": {
						"total": session.get("capacity"),
						"filled": session.get("attendees")
					},
					"time": {
						"start": {
							"raw": session.get("startTime"),
							"formatted": moment(session.get("startTime")).format(timeFormat)
						},
						"end": {
							"raw": session.get("endTime"),
							"formatted": moment(session.get("endTime")).format(timeFormat)
						},
						"date": moment(session.get("startTime")).format(dateFormat)
					},
					"presenters": sessionRelationships[0].records.map(record => record.toObject()),
					"moderator": (sessionRelationships[1].records.length !== 0) ? sessionRelationships[1].records[0].toObject() : null
				};
			}));
			dbSession.close();
			response.json(sessions);
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.post(postParser, async (request, response) => {
		let {slug}: { slug: string } = request.body;
		let {time}: { time: string } = request.params;
		let intendedSession: neo4j.v1.Record | null = null;
		let isOwn = false;
		// 1: Get this specific session and check for existance, time, and capacity
		// 2: Determine if this user presents a session at this time. If so, they must register for it.
		// 3: Determine if this user moderates a session at this time. If so, they must register for it.
		try {
			const dbSession = common.driver.session();
			let [sessions, presentations, moderations, userFreeInfoRaw] = await Promise.all([
				dbSession.run(`
					MATCH (s:Session {slug: {slug}, startTime: {time}})
					RETURN s.startTime AS start, s.capacity AS capacity, s.attendees AS attendees
				`, { slug, time }),
				dbSession.run(`
					MATCH (user:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {time}})
					RETURN s.slug AS slug, s.title AS title
				`, { username: response.locals.user.username, time }),
				dbSession.run(`
					MATCH (user:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {time}})
					RETURN s.slug AS slug, s.title AS title
				`, { username: response.locals.user.username, time }),
				dbSession.run(`
					MATCH (user:User {username: {username}})
					RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree
				`, { username: response.locals.user.username })
			]);
			let userFreeInfo = userFreeInfoRaw.records[0].toObject() as {
				hasFree: boolean;
				timeOfFree: string;
			};
			if (presentations.records.length > 0 && presentations.records[0].get("slug") !== slug) {
				response.json({
					"success": false,
					"message": `You must select the session that you are presenting during this time period: "${presentations.records[0].get("title")}"`
				});
				return;
			}
			if (moderations.records.length > 0 && moderations.records[0].get("slug") !== slug) {
				response.json({
					"success": false,
					"message": `You must select the session that you are moderating during this time period: "${moderations.records[0].get("title")}"`
				});
				return;
			}
			if ((presentations.records.length > 0 && presentations.records[0].get("slug") === slug) || (moderations.records.length > 0 && moderations.records[0].get("slug") === slug)) {
				isOwn = true;
			}

			if (slug !== "free") {
				if (sessions.records.length !== 1) {
					response.json({ "success": false, "message": "Invalid session ID" });
					return;
				}
				let session = sessions.records[0];
				intendedSession = session;
				if (session.get("start") !== time) {
					response.json({ "success": false, "message": "Session has mismatching start time" });
					return;
				}
				if (session.get("attendees") >= session.get("capacity") && !isOwn) {
					response.json({ "success": false, "message": "There are too many people in that session. Please choose another." });
					return;
				}
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree === time) {
					await dbSession.run(`
						MATCH (user:User {username: {username}})
						REMOVE user.hasFree, user.timeOfFree
					`, { username: response.locals.user.username });
				}
			}
			else {
				if (userFreeInfo.hasFree && userFreeInfo.timeOfFree !== time) {
					response.json({ "success": false, "message": "You may select only one free" });
					return;
				}
			}
			
			// Now check if deregistration needs to happen and remove the relationship and decrement the number of attendees (the user selected a different session previously and has changed their mind)
			let results = (await dbSession.run(`
				MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session {startTime: {time}})
				SET s.attendees = s.attendees - 1
				DELETE r
				RETURN s.slug AS slug, s.attendees AS attendees
			`, {
				username: response.locals.user.username,
				time
			})).records.map(record => {
				return {
					slug: record.get("slug"),
					attendees: record.get("attendees")
				};
			});

			// Notify via WebSocket of newly available spaces
			results.forEach(deletedSession => {
				common.io.emit("availability", {
					"slug": deletedSession.slug,
					"attendees": deletedSession.attendees
				});
			});
			if (isOwn) {
				// The attendance isn't increased if the user is a presenter or moderator of the selected session
				await dbSession.run(`
					MATCH (user:User {username: {username}})
					MATCH (session:Session {slug: {slug}})
					CREATE (user)-[r:ATTENDS]->(session)
				`, { username: response.locals.user.username, slug });
			}
			else {
				if (intendedSession !== null) {
					// Notify via WebSocket of the intention to register
					common.io.emit("availability", {
						"slug": slug,
						"attendees": intendedSession.get("attendees") + 1
					});
					await dbSession.run(`
						MATCH (user:User {username: {username}})
						MATCH (session:Session {slug: {slug}})
						CREATE (user)-[r:ATTENDS]->(session)
						SET session.attendees = session.attendees + 1
					`, { username: response.locals.user.username, slug });
				}
				else {
					// Register for a free
					await dbSession.run(`
						MATCH (user:User {username: {username}})
						SET user.hasFree = true, user.timeOfFree = {time}
					`, { username: response.locals.user.username, time });
				}
			}
			dbSession.close();
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
		const dbSession = common.driver.session();
		let [results, periodsRaw, userFreeInfo] = await Promise.all([
			dbSession.run(`
				MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session)
				RETURN s.type AS type
			`, { username: response.locals.user.username }),
			dbSession.run(`
				MATCH (item:ScheduleItem {editable: true})
				RETURN count(item) AS periods
			`),
			dbSession.run(`
				MATCH (user:User {username: {username}})
				RETURN user.hasFree AS hasFree, user.timeOfFree AS timeOfFree
			`, { username: response.locals.user.username })
		]);
		let periods: number = periodsRaw.records[0].get("periods").toNumber();
		let hasSelectedPanel = false;
		let hasSelectedSession = false;
		for (let result of results.records) {
			let type = result.get("type");
			if (type === "Global session" || type === "Science session") {
				hasSelectedSession = true;
				continue;
			}
			if (type === "Panel") {
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
		if (userFreeInfo.records[0].get("hasFree")) {
			periods--;
		}
		if (results.records.length < periods) {
			response.json({ "success": false, "message": "Your registration isn't yet completed" });
			return;
		}

		await dbSession.run(`
			MATCH (user:User {username: {username}})
			SET user.registered = true
		`, { username: response.locals.user.username });
		dbSession.close();
		response.json({ "success": true, "message": "Registration completed successfully" });
	}
	catch (err) {
		common.handleError(response, err);
	}
});
