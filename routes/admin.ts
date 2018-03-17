import * as crypto from "crypto";
import * as common from "../common";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as moment from "moment";
import * as slugMaker from "slug";
import * as sendgrid from "@sendgrid/mail";
import * as multer from "multer";
import * as neo4j from "neo4j-driver";
//import { userRouter } from "./user";
import { getScheduleForUser, ScheduleItem } from "./data";

export let adminRouter = express.Router();

let postParser = bodyParser.json();
sendgrid.setApiKey(common.keys.sendgrid);
let uploadHandler = multer({
	"storage": multer.memoryStorage(),
	"limits": {
		"fileSize": 1000000 * 10, // 10 MB
		"files": 1,
		"fields": 0
	},
	"fileFilter": function (request, file, callback) {
		const excelMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		if (file.mimetype === excelMimeType && !!file.originalname.match("\.xlsx$")) {
			callback(null!, true);
		}
		else {
			callback(null!, false);
		}
	}
});
const xlsx = require("node-xlsx");

type RawUser = common.RawUser;
interface UserParameters {
	name: string;
	username: string;
	registered: boolean;
	type: common.UserType;
	admin: boolean;
	code: string;
	grade: number | null;
}

const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

let authenticateCheck = common.authenticateMiddleware;
let adminCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || !response.locals.user.admin) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("Forbidden to non-admin users");
		}
	}
	else {
		next();
	}
};
adminRouter.use(authenticateCheck, adminCheck);

adminRouter.route("/").get(async (request, response) => {
	response.send(await common.readFileAsync("pages/admin.html"));
});

adminRouter.route("/user")
	.get(async (request, response) => {
		const dbSession = common.driver.session();
		if (request.query.all && request.query.all.toLowerCase() === "true") {
			// All users' names for autocomplete
			try {
				let results = await dbSession.run(`
					MATCH (user:User)
					RETURN user.name AS name
					ORDER BY last(split(user.name, " "))
				`);
				response.json(results.records.map(user => {
					return user.get("name");
				}));
			}
			catch (err) {
				common.handleError(response, err);
			}
		}
		else {
			const usersPerPage = 10;
			let page = parseInt(request.query.page, 10);
			if (isNaN(page) || page < 0) {
				page = 0;
			}
			let filter = request.query.filter;
			let criteria: string = "";
			if (!filter)
				filter = "all";
			if (filter === "all") {
				criteria = "";
			}
			else if (filter === "freshman") {
				criteria = "grade: 9";
			}
			else if (filter === "sophomore") {
				criteria = "grade: 10";
			}
			else if (filter === "junior") {
				criteria = "grade: 11";
			}
			else if (filter === "senior") {
				criteria = "grade: 12";
			}
			else if (filter === "admin") {
				criteria = "admin: true";
			}
			else if (filter === "nonadmin") {
				criteria = "admin: false";
			}
			else {
				criteria = "type: {type}";
			}
			try {
				let results = await Promise.all([
					dbSession.run(`
						MATCH (user:User {${criteria}})
						RETURN
							user.username AS username,
							user.name AS name,
							user.email AS email,
							user.registered AS registered,
							user.admin AS admin,
							user.type AS type,
							user.code AS code
						ORDER BY last(split(user.name, " "))
						SKIP {skip}
						LIMIT {limit}
					`, {
						skip: page * usersPerPage,
						limit: usersPerPage,
						type: common.getUserType(filter)
					}),
					dbSession.run(`
						MATCH (user:User {${criteria}})
						RETURN count(user) AS total
					`, { type: common.getUserType(filter) })
				]);
				let total: number = results[1].records[0].get("total").toNumber();
				response.json({
					"info": {
						"page": page + 1,
						"pageSize": usersPerPage,
						"total": total,
						"totalPages": Math.ceil(total / usersPerPage)
					},
					"data": results[0].records.map(function (user) {
						return {
							...user.toObject(),
							email: user.get("email") || `${user.get("username")}@gfacademy.org`
						};
					})
				});
			}
			catch (err) {
				common.handleError(response, err);
			}
		}
		dbSession.close();
	})
	.post(uploadHandler.single("import"), async (request, response) => {
		type Sheet = {
			name: string;
			data: string[][];
		};
		let data: [Sheet, Sheet]; // One sheet for students, one for faculty
		try {
			// CAUTION: This is a blocking method
			data = xlsx.parse(request.file.buffer);
		}
		catch (err) {
			response.json({ "success": false, "message": "Invalid Excel file uploaded" });
			return;
		}
		if (data.length !== 2) {
			response.json({ "success": false, "message": "Please put students on the first sheet and faculty on the second" });
			return;
		}
		let queries: {
			text: string;
			parameters: UserParameters;
		}[] = [];
		let emailRegEx = /^(.*?)@gfacademy.org$/i;

		for (let [sheetIndex, sheet] of data.entries()) {
			for (let [i, person] of sheet.data.entries()) {
				if (person.length === 0)
					continue;
				let firstName = person[0];
				let lastName = person[1];
				let email = person[2];
				// Grade only exists for students (first sheet)
				// Will parse undefined -> NaN
				let grade = parseInt(person[3], 10);
				// Last part = if on student sheet && grade is invalid && ignoring header row
				if (!firstName || !lastName || !email || (sheetIndex == 0 && i !== 0 && isNaN(grade))) {
					response.json({ "success": false, "message": "Invalid format for students. Expected first name, last name, email, grade." });
					return;
				}
				let emailParsed = email.match(emailRegEx);
				// Check if there is actually an email in the email field. If not, it's probably the header
				if (!emailParsed)
					continue;
				let code = crypto.randomBytes(16).toString("hex");
				let type: common.UserType = common.UserType.Other;
				if (sheetIndex === 0) {
					type = common.UserType.Student;
				}
				else if (sheetIndex === 1) {
					type = common.UserType.Teacher;
				}
				queries.push({
					text: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}, grade: {grade}})",
					parameters: {
						name: `${firstName} ${lastName}`,
						username: emailParsed[1],
						registered: false,
						type,
						admin: false,
						code,
						grade: isNaN(grade) ? null : grade
					}
				});
			}
		}

		const dbSession = common.driver.session();
		let tx = dbSession.beginTransaction();
		try {
			// Run pending queries in parallel and roll back on failure
			await Promise.all(queries.map(query => tx.run(query)));
			await tx.commit();
			response.json({ "success": true, "message": `${queries.length} users successfully created` });
		}
		catch (err) {
			if (err.code === "Neo.ClientError.Schema.ConstraintValidationFailed") {
				// Find and show duplicate username(s) or name(s)
				let repeats = await Promise.all(
					// Spread operator used for concatenating student and teacher arrays
					[...data[0].data, ...data[1].data].map(user => {
						let emailParsed = user[2].match(emailRegEx);
						return dbSession.run(`
							MATCH (user:User)
							WHERE user.name = {name} OR user.username = {username}
							RETURN user.username AS username, user.name AS name
						`, { name: `${user[0]} ${user[1]}`, username: emailParsed ? emailParsed[1] : "" });
					})
				);
				let formattedRepeats: string = repeats.filter(item => item.records.length !== 0).map(item => item.records[0].get("name")).join(", ");

				response.json({ "success": false, "message": `A user with an existing username or name can't be imported. (${formattedRepeats}) Rolling back changes.` });
				return;
			}
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.delete(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			await dbSession.run(`
				MATCH (user:User {admin: false})
				DETACH DELETE user
			`);
			await dbSession.run(`
				MATCH (user:User {admin: true})
				SET user.registered = false
			`);
			response.json({ "success": true, "message": "All non-admin users successfully deleted" });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});

adminRouter.route("/user/:username")
	.get(async (request, response) => {
		let username = request.params.username;
		const dbSession = common.driver.session();
		try {
			let results = await dbSession.run(`
				MATCH (user:User {username: {username}})
				RETURN
					user.username AS username,
					user.name AS name,
					user.email AS email,
					user.registered AS registered,
					user.admin AS admin,
					user.type AS type,
					user.code AS code
			`, { username });

			if (results.records.length == 0) {
				response.json(null);
			}
			else {
				response.json({
					...results.records[0].toObject(),
					// Generate email from the username if it doesn't exist
					email: results.records[0].get("email") || `${results.records[0].get("username")}@gfacademy.org`
				});
			}
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.put(postParser, async (request, response) => {
		// Generate a unique code for this user
		let code = crypto.randomBytes(16).toString("hex");
		let name: string | undefined = request.body.name;
		let username: string | undefined = request.params.username;
		// Single equals assignments here are intentional
		if (!name || !username || !(name = name.trim()) || !(username = username.toLowerCase().trim())) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		let isTeacher = !!request.body.teacher;
		let isAdmin = !!request.body.admin;
		const dbSession = common.driver.session();
		try {
			let userInfo: UserParameters = {
				name,
				username,
				registered: false,
				type: isTeacher ? common.UserType.Teacher : common.UserType.Student,
				admin: isAdmin,
				grade: null,
				code
			};
			await dbSession.run(`
				CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})
			`, userInfo);
			response.json({ "success": true, "message": "User successfully created" });
		}
		catch (err) {
			if (err.code === "Neo.ClientError.Schema.ConstraintValidationFailed") {
				response.json({ "success": false, "message": "A user with that username or name already exists" });
				return;
			}
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.delete(async (request, response) => {
		let username: string = request.params.username;
		const dbSession = common.driver.session();
		try {
			await dbSession.run(`
				MATCH (user:User {username: {username}}) DETACH DELETE user
			`, { username });
			response.json({ "success": true, "message": "User deleted successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/move/:name")
	.get(async (request, response) => {
		let name: string = request.params.name;
		const dbSession = common.driver.session();
		try {
			let [users, editablePeriods, attends, presents, moderates] = await Promise.all([
				dbSession.run(`
					MATCH (u:User)
					WHERE u.name = {name} OR u.username = {name}
					RETURN u.name AS name, u.username AS username, u.code AS code, u.registered AS registered
				`, { name }),
				dbSession.run(`
					MATCH (item:ScheduleItem {editable: true })
					RETURN item.title AS title, item.start AS startTime, item.end AS endTime
				`),
				dbSession.run(`
					MATCH (u:User)
					WHERE u.name = {name} OR u.username = {name}
					MATCH (u)-[r:ATTENDS]->(s:Session)
					RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type
				`, { name }),
				dbSession.run(`
					MATCH (u:User)
					WHERE u.name = {name} OR u.username = {name}
					MATCH (u)-[r:PRESENTS]->(s:Session)
					RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type
				`, { name }),
				dbSession.run(`
					MATCH (u:User)
					WHERE u.name = {name} OR u.username = {name}
					MATCH (u)-[r:MODERATES]->(s:Session)
					RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type
				`, { name })
			]);
			
			if (users.records.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return;
			}
			let user = users.records[0].toObject() as RawUser;

			function findByTime<T extends neo4j.v1.Record>(items: T[], time: moment.Moment): T | null {
				for (let item of items) {
					if (time.isSame(moment(item.get("startTime")))) {
						return item;
					}
				}
				return null;
			}
			function formatSession(item: neo4j.v1.Record, mandatory: boolean = false, isFree: boolean = false) {
				return {
					"title": {
						"formatted": !isFree ? item.get("title") : "Free",
						"slug": item.get("slug") || null
					},
					"time": {
						"start": {
							"raw": item.get("startTime"),
							"formatted": moment(item.get("startTime")).format(timeFormat)
						},
						"end": {
							"raw": item.get("endTime"),
							"formatted": moment(item.get("endTime")).format(timeFormat)
						}
					},
					"type": item.get("type") || null,
					"mandatory": mandatory
				};
			}

			let periods = editablePeriods.records.map(period => {
				let startTime = moment(period.get("startTime"));
				let presenting = findByTime(presents.records, startTime);
				if (presenting) {
					return formatSession(presenting, true);
				}
				let moderating = findByTime(moderates.records, startTime);
				if (moderating) {
					return formatSession(moderating, true);
				}
				let attending = findByTime(attends.records, startTime);
				if (attending) {
					return formatSession(attending);
				}
				return formatSession(period, false, true);
			});
			response.json({ "success": true, "data": periods, "user": user });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.post(postParser, async (request, response) => {
		let {username, slugs}: { username: string, slugs: string[] } = request.body;
		const dbSession = common.driver.session();
		try {
			let [users, editablePeriods] = await Promise.all([
				dbSession.run(`
					MATCH (u:User {username: {username}})
					RETURN u.name AS name, u.username AS username, u.registered AS registered
				`, { username }),
				dbSession.run(`
					MATCH(item:ScheduleItem {editable: true })
					RETURN item.title AS title, item.start AS startTime, item.end AS endTime
				`)
			]);

			if (users.records.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return;
			}
			if (editablePeriods.records.length !== slugs.length) {
				response.json({ "success": false, "message": "Incorrect number of changes for editable periods" });
				return;
			}
			// Remove from already registered sessions
			await dbSession.run(`
				MATCH (u:User {username: {username}})-[r:ATTENDS]->(s:Session)
				SET s.attendees = s.attendees - 1 
				DELETE r
				REMOVE u.hasFree, u.timeOfFree
			`, { username });
			
			// Frees have null as their slug
			slugs = slugs.filter(slug => slug !== null);
			let tx = dbSession.beginTransaction();
			try {
				await Promise.all(slugs.map(slug => {
					return tx.run(`
						MATCH (user:User {username: {username}})
						MATCH (session:Session {slug: {slug}})
						CREATE (user)-[r:ATTENDS]->(session)
						SET session.attendees = session.attendees + 1
						SET user.registered = true
					`, { username, slug });
				}));
				await tx.commit();
				response.json({ "success": true, "message": "User moved successfully" });
			}
			catch (err) {
				console.error(err);
				response.json({ "success": false, "message": "An error occurred while moving the user. All changes rolled back." });
			}
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/session")
	.get(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			let sessions = await dbSession.run(`
				MATCH (s:Session) RETURN
					s.title AS title,
					s.slug AS slug,
					s.description AS description,
					s.type AS type,
					s.location AS location,
					s.capacity AS capacity,
					s.attendees AS attendees,
					s.startTime AS startTime,
					s.endTime AS endTime
				ORDER BY s.startTime, lower(s.title)
			`);
			let formattedSessions = await Promise.all(sessions.records.map(async session => {
				let slug = session.get("slug");
				let presenterRelationships = await dbSession.run(`
					MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }})
					RETURN user.username AS username, user.name AS name
					ORDER BY last(split(user.name, " "))
				`, { slug });
				let moderatorRelationship = await dbSession.run(`
					MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }})
					RETURN user.username AS username, user.name AS name
				`, { slug });

				return {
					"title": {
						"formatted": session.get("title"),
						slug
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
					"presenters": presenterRelationships.records.map(presenter => presenter.toObject()),
					"moderator": (moderatorRelationship.records.length !== 0) ? moderatorRelationship.records[0].toObject() : null
				};
			}));
			response.json(formattedSessions);
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.post(postParser, async (request, response) => {
		// Adds a session
		let title: string | undefined = request.body.title;
		let slug = slugMaker(title || "", { "lower": true });
		let description: string | null | undefined = request.body.description;
		let location: string | undefined = request.body.location;
		let capacity: number = request.body.capacity;
		let sessionType: string | undefined = request.body.type;
		let periodID: string | undefined = request.body.periodID;
		let presenters: { name: string }[] = request.body.presenters;
		let moderator: string | undefined = request.body.moderator;
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		if (!title || !location || !sessionType || !periodID) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.trim();
		if (description) {
			description = description.trim();
		}
		else {
			description = null;
		}
		location = location.trim();
		sessionType = sessionType.trim();
		periodID = periodID.trim();
		if (!title || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		if (!isInteger(capacity) || capacity < 1) {
			response.json({ "success": false, "message": "Please enter a valid capacity" });
			return;
		}
		if (moderator) {
			moderator = moderator.trim();
		}
		if (!Array.isArray(presenters) || presenters.length < 1) {
			response.json({ "success": false, "message": "Please add a presenter" });
			return;
		}
		if (moderator && sessionType !== "Panel") {
			response.json({ "success": false, "message": "Only panels can have a moderator" });
			return;
		}
		if (sessionType !== "Panel" && presenters.length > 1) {
			response.json({ "success": false, "message": "Only one presenter is allowed per session" });
			return;
		}
		if (!moderator && sessionType === "Panel") {
			response.json({ "success": false, "message": "Panels must have a moderator" });
			return;
		}
		let presenterNames = presenters.map(presenter => presenter.name);
		let allUsers = (!moderator) ? presenterNames : presenterNames.concat(moderator);

		const dbSession = common.driver.session();
		let tx = dbSession.beginTransaction();
		// Make sure that all presenters and moderators actually exist
		try {
			let results = await tx.run(`
				MATCH (u:User)
				WHERE u.name IN { names }
				RETURN count(u) AS users
			`, { names: allUsers });

			if (allUsers.length !== results.records[0].get("users").toNumber()) {
				if (sessionType !== "Panel") {
					response.json({ "success": false, "message": "The presenter could not be found" });
				}
				else {
					response.json({ "success": false, "message": "The moderator or one or more presenters could not be found" });
				}
				return;
			}

			let period = await tx.run(`
				MATCH (item:ScheduleItem {id: {id}, editable: true})
				RETURN item.id AS id, item.start AS start, item.end AS end
			`, { id: periodID });
			if (period.records.length !== 1) {
				response.json({ "success": false, "message": "A customizable period with that ID could not be found" });
				return;
			}

			await tx.run(`
				CREATE (session:Session {
					title: { title },
					slug: { slug },
					description: { description },
					type: { type },
					location: { location },
					capacity: { capacity },
					attendees: { attendees },
					startTime: { startTime },
					endTime: { endTime }
				})`, {
				title,
				slug,
				description,
				location,
				capacity,
				attendees: 0,
				type: sessionType,
				startTime: period.records[0].get("start"),
				endTime: period.records[0].get("end")
			});
			for (let presenter of presenters) {
				let operations: neo4j.v1.Result[] = [
					tx.run(`
						MATCH (user:User {name: { name }})
						MATCH (session:Session {slug: { slug }})
						CREATE (user)-[r:PRESENTS]->(session)
					`, { name: presenter.name, slug })
				];
				if (moderator) {
					operations.push(
						tx.run(`
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:MODERATES]->(session)
						`, { name: moderator, slug })
					);
				}
				await Promise.all(operations);
			}
			await tx.commit();
			response.json({ "success": true, "message": "Session successfully created" });
		}
		catch (err) {
			if (err.code === "Neo.ClientError.Schema.ConstraintValidationFailed") {
				response.json({ "success": false, "message": "A session with that title already exists" });
				return;
			}
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.delete(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			let [, unregistered] = await Promise.all([
				dbSession.run(`
					MATCH (s:Session)
					DETACH DELETE s
				`),
				dbSession.run(`
					MATCH (u:User {registered: true})
					SET u.registered = false
					RETURN count(u) AS unregistered
				`)
			]);
			response.json({ "success": true, "message": `All sessions deleted successfully. ${unregistered.records[0].get("unregistered")} users were marked unregistered.` });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/session/:slug")
	.get(async (request, response) => {
		let slug = request.params.slug;
		const dbSession = common.driver.session();
		try {
			let [sessions, presenters, moderators] = await Promise.all([
				dbSession.run(`
					MATCH (s:Session {slug: {slug}}) RETURN
						s.title AS title,
						s.slug AS slug,
						s.description AS description,
						s.type AS type,
						s.location AS location,
						s.capacity AS capacity,
						s.attendees AS attendees,
						s.startTime AS startTime,
						s.endTime AS endTime
				`, { slug }),
				dbSession.run(`
					MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}})
					RETURN user.username AS username, user.name AS name
					ORDER BY last(split(user.name, " "))
				`, { slug }),
				dbSession.run(`
					MATCH (user:User)-[r:MODERATES]->(s:Session {slug: {slug}})
					RETURN user.username AS username, user.name AS name
				`, { slug })
			]);
			if (sessions.records.length == 0) {
				response.json(null);
			}
			else {
				let session = sessions.records[0];
				response.json({
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
					"presenters": presenters.records.map(presenter => presenter.toObject()),
					"moderator": (moderators.records.length !== 0) ? moderators.records[0].toObject() : null
				});
			}
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.delete(async (request, response) => {
		let slug = request.params.slug;
		const dbSession = common.driver.session();
		try {
			await dbSession.run(`
				MATCH (s:Session {slug: {slug}})
				DETACH DELETE s
			`, { slug });
			response.json({ "success": true, "message": "Session deleted successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/session/:slug/attendance").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/session.html"));
});
adminRouter.route("/session/:slug/attendance/data").get(async (request, response) => {
	let slug = request.params.slug;
	const dbSession = common.driver.session();
	try {
		let results = await dbSession.run(`
			MATCH (user:User)-[r:ATTENDS]->(s:Session {slug: {slug}})
			RETURN user.username AS username, user.name AS name, user.type AS type
			ORDER BY last(split(user.name, " "))
		`, { slug });
		let students = results.records.filter(user => {
			return user.get("type") === common.UserType.Student;
		});
		let faculty = results.records.filter(user => {
			return user.get("type") === common.UserType.Teacher;
		});
		response.json({
			"faculty": faculty,
			"students": students
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/free/:id").get(async (request, response) => {
	let id = request.params.id;
	const dbSession = common.driver.session();
	try {
		let results = await dbSession.run(`
			MATCH (item:ScheduleItem {id: {id}})
			RETURN item.title AS title, item.start AS startTime, item.end AS endTime
		`, { id });

		response.json({
			"title": {
				"formatted": results.records[0].get("title") + " Free",
				"slug": null
			},
			"description": "",
			"type": "Free",
			"location": "N/A",
			"capacity": {
				"total": 0,
				"filled": 0
			},
			"time": {
				"start": {
					"raw": results.records[0].get("startTime"),
					"formatted": moment(results.records[0].get("startTime")).format(timeFormat)
				},
				"end": {
					"raw": results.records[0].get("endTime"),
					"formatted": moment(results.records[0].get("endTime")).format(timeFormat)
				},
				"date": moment(results.records[0].get("startTime")).format(dateFormat)
			},
			"presenters": [{"name": "N/A"}],
			"moderator": null
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/free/:id/attendance").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/session.html"));
});
adminRouter.route("/free/:id/attendance/data").get(async (request, response) => {
	let id = request.params.id;
	const dbSession = common.driver.session();
	try {
		let results = await dbSession.run(`
			MATCH (item:ScheduleItem {id: {id}})
			MATCH (user:User {registered: true})
			WHERE NOT (user)-[:ATTENDS]->(:Session {startTime: item.start})
			RETURN user.username AS username, user.name AS name, user.type AS type
			ORDER BY last(split(user.name, " "))
		`, { id });
		let students = results.records.filter(user => {
			return user.get("type") === common.UserType.Student;
		});
		let faculty = results.records.filter(user => {
			return user.get("type") === common.UserType.Teacher;
		});
		response.json({
			"faculty": faculty.map(faculty => faculty.toObject()),
			"students": students.map(student => student.toObject())
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/schedule")
	.get(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			let results = await dbSession.run(`
				MATCH (item:ScheduleItem)
				RETURN
					item.id AS id,
					item.title AS title,
					item.start AS start,
					item.end AS end,
					item.location AS location,
					item.editable AS editable
				ORDER BY item.start
			`);
			response.json(results.records.map(item => {
				return {
					"id": item.get("id"),
					"title": item.get("title"),
					"location": item.get("location"),
					"editable": item.get("editable") || false,
					"time": {
						"start": {
							"raw": item.get("start"),
							"formatted": moment(item.get("start")).format(timeFormat)
						},
						"end": {
							"raw": item.get("end"),
							"formatted": moment(item.get("end")).format(timeFormat)
						}
					}
				};
			}));
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession
		}
	})
	.patch(postParser, async (request, response) => {
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		let { id, title, startTime, duration, location, customizable }: {
			id: string,
			title: string,
			startTime: string,
			duration: number,
			location: string | null,
			customizable: boolean
		} = request.body;
		if (!id) {
			response.json({ "success": false, "message": "Missing ID" });
			return;
		}
		if (!title || !startTime || !duration || typeof customizable !== "boolean") {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.trim();
		startTime = startTime.trim();
		if (location) {
			location = location.trim() || null;
		}
		else {
			location = null;
		}
		if (!isInteger(duration) || duration < 1) {
			response.json({ "success": false, "message": "Please enter a valid duration" });
			return;
		}
		const dbSession = common.driver.session();
		try {
			let date = await common.getSymposiumDate();
			let start = moment(startTime, timeFormat);
			start.set("year", date.get("year"));
			start.set("month", date.get("month"));
			start.set("date", date.get("date"));
			let end = start.clone().add(duration, "minutes");

			if (!start.isValid() || !end.isValid()) {
				response.json({ "success": false, "message": "Invalid start time or duration" });
				return;
			}

			await dbSession.run(`
				MATCH (item:ScheduleItem {id: {id}})
				SET
					item.title = {title},
					item.start = {startTime},
					item.end = {endTime},
					item.location = {location},
					item.editable = {customizable}
			`, {
				id,
				title,
				startTime: start.format(),
				endTime: end.format(),
				location,
				customizable
			});
			response.json({ "success": true, "message": "Updated successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});

adminRouter.route("/schedule/:filter").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/schedule.html"));
});
adminRouter.route("/schedule/:filter/data").get(async (request, response) => {
	let filter: string | undefined = request.params.filter;
	if (!filter) {
		filter = "all";
	}
	filter = filter.toLowerCase();
	let criteria: string = "";
	if (filter === "all") {
		criteria = "";
	}
	else if (filter === "freshman") {
		criteria = "grade: 9";
	}
	else if (filter === "sophomore") {
		criteria = "grade: 10";
	}
	else if (filter === "junior") {
		criteria = "grade: 11";
	}
	else if (filter === "senior") {
		criteria = "grade: 12";
	}
	else {
		criteria = "type: {type}";
	}
	const dbSession = common.driver.session();
	try {
		let users = await dbSession.run(`
			MATCH (u:User {${criteria}})
			RETURN
				u.name AS name,
				u.username AS username,
				u.registered AS registered
			ORDER BY last(split(u.name, " "))
		`, { type: common.getUserType(filter) });
		let results = await Promise.all(users.records.map(async user => {
			return {
				name: user.get("name"),
				schedule: await getScheduleForUser({
					username: user.get("username"),
					registered: user.get("registered")
				})
			}
		}));
		response.json(results);
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/schedule/user/:name").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/schedule.html"));
});
adminRouter.route("/schedule/user/:name/data").get(async (request, response) => {
	let name: string = request.params.name;
	const dbSession = common.driver.session();
	try {
		let user = (await dbSession.run(`
			MATCH (u:User)
			WHERE u.name = {name} OR u.username = {name}
			RETURN u.name AS name, u.username AS username, u.registered AS registered
		`, { name })).records;
		let schedule: { name: string; schedule: ScheduleItem[] };
		if (user.length !== 1) {
			schedule = {
				name: "Unknown user",
				schedule: await getScheduleForUser({
					"username": "unknown",
					"registered": false
				})
			};
		}
		else {
			schedule = {
				name: user[0].get("name"),
				schedule: await getScheduleForUser({
					username: user[0].get("username"),
					registered: user[0].get("registered")
				})
			};
		}
		// Wrap in an array because the schedule displayer is used for both lists of schedules and individual schedules
		response.json([schedule]);
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
/*adminRouter.route("/schedule/switch").patch(postParser, (request, response) => {
	let {id1, id2}: { id1: string, id2: string } = request.body;
	if (!id1 || !id2) {
		response.json({ "success": false, "message": "Missing IDs" });
		return;
	}
	Promise.map([id1, id2], function (id) {
		return common.cypherAsync({
			query: "MATCH (item:ScheduleItem {id: {id}}) RETURN item.id AS id, item.start AS start, item.end AS end",
			params: {
				id: id
			}
		});
	}).spread(function (item1, item2) {
		//if (item1.length !== 1 || !item2.length !== 1) {

		//}
	});
});*/
adminRouter.route("/schedule/date")
	.patch(postParser, async (request, response) => {
		let rawDate: string | undefined = request.body.date;
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		rawDate = rawDate.trim();
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		let date: moment.Moment = moment(rawDate, dateFormat);
		if (!date.isValid()) {
			response.json({ "success": false, "message": "Invalid date input" });
			return;
		}

		const dbSession = common.driver.session();
		// Get all schedule items and sessions
		try {
			let [scheduleItems, sessions] = await Promise.all([
				dbSession.run(`
					MATCH (item:ScheduleItem)
					RETURN item.id AS id, item.start AS start, item.end AS end
				`),
				dbSession.run(`
					MATCH (s:Session)
					RETURN s.slug AS slug, s.startTime AS start, s.endTime AS end
				`)
			]);
			function changeDateOnRecord(record: neo4j.v1.Record): { start: string; end: string } {
				let start = moment(record.get("start"));
				let end = moment(record.get("end"));
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				return {
					start: start.format(),
					end: end.format()
				};
			}
			let queries: { text: string; parameters: any; }[] = [{
				text: `
					MATCH (c:Constant)
					WHERE c.date IS NOT NULL
					SET c.date = { date }
					RETURN c
				`,
				parameters: {
					date: date.format("YYYY-MM-DD")
				}
			}];
			queries = queries.concat(scheduleItems.records.map(item => {
				return {
					text: `
						MATCH (item:ScheduleItem {id: {id}})
						SET item.start = {start}, item.end = {end}
					`,
					parameters: {
						id: item.get("id"),
						...changeDateOnRecord(item)
					}
				};
			}));
			queries = queries.concat(sessions.records.map(session => {
				return {
					text: `
						MATCH (s:Session {slug: {slug}})
						SET s.startTime = {start}, s.endTime = {end}
					`,
					parameters: {
						slug: session.get("slug"),
						...changeDateOnRecord(session)
					}
				};
			}));

			let tx = dbSession.beginTransaction();
			await Promise.all(queries.map(query => tx.run(query)));
			await tx.commit();
			response.json({ "success": true, "message": "Symposium date changed successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/registration/email").get(async (request, response) => {
	const dbSession = common.driver.session();
	try {
		let [registration, schedule] = await Promise.all([
			dbSession.run("MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL RETURN c"),
			dbSession.run("MATCH (c:Constant) WHERE c.scheduleEmailTime IS NOT NULL RETURN c")
		]);
		let registrationEmailTime = moment(registration.records[0].get("c").properties.registrationEmailTime);
		let scheduleEmailTime = moment(schedule.records[0].get("c").properties.scheduleEmailTime);
		response.json({
			"registration": {
				"raw": registration.records[0].get("c").properties.registrationEmailTime,
				"formatted": `${registrationEmailTime.format(dateFormat)} at ${registrationEmailTime.format(timeFormat)}`
			},
			"schedule": {
				"raw": schedule.records[0].get("c").properties.scheduleEmailTime,
				"formatted": `${scheduleEmailTime.format(dateFormat)} at ${scheduleEmailTime.format(timeFormat)}`
			}
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/registration/email/registration").post(async (request, response) => {
	const dbSession = common.driver.session();
	// Get emails to send to
	try {
		let date = await common.getSymposiumDate();
		let results = await dbSession.run(`
			MATCH (u:User)
			RETURN
				u.name AS name,
				u.username AS username,
				u.email AS email,
				u.code AS code
		`);
		let totalRecipients = results.records.length;
		let emails = [];
		let users = results.records.map(user => user.toObject() as {
			name: string;
			username: string;
			email: string;
			code: string;
		});
		for (let user of users) {
			let email = user.email || `${user.username}@gfacademy.org`;
			let emailToSend = {
				to: { name: user.name, email },
				from: {
					name: "GFA World Perspectives Symposium",
					email: "registration@wppsymposium.org"
				},
				subject: "GFA WPP Symposium Registration",
				text:
				`Hi ${user.name},

This year's World Perspectives Symposium will take place on ${date.format(dateFormat)}. To login and register for presentations, visit the following link:

https://wppsymposium.org/user/login/${user.code}

Be sure to register for presentations soon before they fill up. You can visit the link at any time after you've registered to view your schedule. If you miss the registration cut-off date, your schedule will be automatically generated based on availability.

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			};
			emails.push(emailToSend);
		}
		await sendgrid.send(emails);

		await dbSession.run(`
			MATCH (c:Constant)
			WHERE c.registrationEmailTime IS NOT NULL
			SET c.registrationEmailTime = {time}
			RETURN c
		`, { time: moment().format() });
		response.json({ "success": true, "message": `Sent registration emails to ${totalRecipients} recipients` });
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/registration/email/schedule").post(async (request, response) => {
	const dbSession = common.driver.session();
	// Get emails to send to
	try {
		let date = await common.getSymposiumDate();
		let results = await dbSession.run(`
			MATCH (u:User)
			RETURN
				u.name AS name,
				u.username AS username,
				u.email AS email,
				u.code AS code,
				u.registered AS registered
			`);
		let totalRecipients = results.records.length;
		let emails = [];
		let users = results.records.map(user => user.toObject() as {
			name: string;
			username: string;
			email: string;
			code: string;
			registered: boolean;
		});
		for (let user of users) {
			let schedule = await getScheduleForUser({
				"username": user.username,
				"registered": user.registered
			});
			// Generate schedule for email body
			let scheduleFormatted = schedule.map(scheduleItem => {
				return `${scheduleItem.time.start.formatted} to ${scheduleItem.time.end.formatted}${scheduleItem.location ? " in " + scheduleItem.location : ""}: ${scheduleItem.title}${scheduleItem.type ? ` (${scheduleItem.type})` : ""}`;
			}).join("\n\n");

			let email = user.email || `${user.username}@gfacademy.org`;
			let emailToSend = {
				to: email,
				from: "registration@wppsymposium.org",
				fromname: "GFA World Perspectives Symposium",
				subject: "Your symposium schedule",
				text:
				`Hi ${user.name},

Here is your schedule for this year's World Perspectives Symposium taking place on ${date.format("dddd")} ${date.format(dateFormat)}:

${scheduleFormatted}

You can also visit the following link to view and print a more detailed schedule: https://wppsymposium.org/user/login/${user.code}

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			};
			emails.push(emailToSend);
		}
		await sendgrid.send(emails);

		await dbSession.run(`
			MATCH (c:Constant)
			WHERE c.scheduleEmailTime IS NOT NULL
			SET c.scheduleEmailTime = {time}
			RETURN c
		`, { time: moment().format() });
		response.json({ "success": true, "message": `Sent schedule emails to ${totalRecipients} recipients` });
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
adminRouter.route("/registration/open")
	.get(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			let result = await dbSession.run("MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c");
			let registrationOpen: boolean = result.records[0].get("c").properties.registrationOpen;
			response.json({
				"open": registrationOpen
			});
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	})
	.put(postParser, async (request, response) => {
		let open: boolean | null = request.body.open;
		if (typeof open !== "boolean") {
			response.json({ "success": false, "message": "Invalid open value" });
			return;
		}
		const dbSession = common.driver.session();
		try {
			await dbSession.run(`
				MATCH (c:Constant)
				WHERE c.registrationOpen IS NOT NULL
				SET c.registrationOpen = {open}
				RETURN c
			`, { open });
			response.json({ "success": true, "message": `Registration is now ${open ? "open" : "closed"}` });
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/registration/stats")
	.get(async (request, response) => {
		const dbSession = common.driver.session();
		try {
			let results = await dbSession.run(`
				MATCH (u:User)
				WHERE u.type = 0 OR u.type = 1
				RETURN u.registered AS registered, u.type AS type
			`);
			let registeredStudents = 0;
			let totalStudents = 0;
			let registeredTeachers = 0;
			let totalTeachers = 0;
			results.records.forEach(result => {
				if (result.get("type") === common.UserType.Student) {
					totalStudents++;
					if (result.get("registered")) {
						registeredStudents++;
					}
				}
				if (result.get("type") === common.UserType.Teacher) {
					totalTeachers++;
					if (result.get("registered")) {
						registeredTeachers++;
					}
				}
			});
			response.json({
				"students": {
					"total": totalStudents,
					"registered": registeredStudents
				},
				"faculty": {
					"total": totalTeachers,
					"registered": registeredTeachers
				}
			});
		}
		catch (err) {
			common.handleError(response, err);
		}
		finally {
			dbSession.close();
		}
	});
adminRouter.route("/registration/auto").post(async (request, response) => {
	const dbSession = common.driver.session();
	// Get all unregistered users and all sessions first
	try {
		let [users, editablePeriods, rawSessions] = (await Promise.all([
			dbSession.run(`
				MATCH (u:User {registered: false})
				RETURN u.username AS username
			`),
			dbSession.run(`
				MATCH(item:ScheduleItem { editable: true })
				RETURN item.title AS title, item.start AS startTime, item.end AS endTime
			`),
			dbSession.run(`
				MATCH (s:Session)
				RETURN
					s.slug AS slug,
					s.attendees AS attendees,
					s.capacity AS capacity,
					s.startTime AS startTime,
					s.endTime AS endTime
			`)
		])).map(result => result.records);
		type Session = {
			slug: string;
			attendees: number;
			capacity: number;
			startTime: string;
			endTime: string;
		}
		let sessions = rawSessions.map(session => {
			return {
				...session.toObject(),
				attendees: session.get("attendees"),
				capacity: session.get("capacity")
			} as Session;
		});

		let totalUsers = users.length;
		for (let period of editablePeriods) {
			function shuffle<T>(array: T[]): T[] {
				let counter = array.length;
				// While there are elements in the array
				while (counter > 0) {
					// Pick a random index
					let index = Math.floor(Math.random() * counter);
					// Decrease counter by 1
					counter--;
					// And swap the last element with it
					let temp = array[counter];
					array[counter] = array[index];
					array[index] = temp;
				}
				return array;
			}
			// Shuffle users for each period
			users = shuffle(users);
			// Find non-full sessions that occur at this time
			let availableSessions: Session[] = [];
			function updateAvailableSessions(): boolean {
				availableSessions = sessions.filter(session => {
					return session.attendees < session.capacity && moment(session.startTime).isSame(moment(period.get("startTime")));
				});
				if (availableSessions.length < 1) {
					// Not enough sessions
					let message = `Not enough capacity at ${moment(period.get("startTime")).format(timeFormat)} to autoregister`;
					response.json({ "success": false, message });
					return false;
				}
				availableSessions = availableSessions.sort((a, b) => a.attendees - b.attendees);
				return true;
			}
			if (!updateAvailableSessions()) return;
			// Find the unregistered users that have registered for this period already (partially completed registration) to filter them out of needing to be autoregistered
			let attendingUsers = (await dbSession.run(`
				MATCH (u:User {registered: false})-[r:ATTENDS]->(s:Session {startTime: {startTime}})
				RETURN u.username AS username
			`, {
				startTime: period.get("startTime")
			})).records.map(user => user.toObject() as RawUser);

			let attendingUsernames = attendingUsers.map(attendingUser => {
				return attendingUser.username;
			});
			let remainingUsers = users.filter(user => {
				return attendingUsernames.indexOf(user.get("username")) === -1;
			});
			for (let user of remainingUsers) {
				if (!updateAvailableSessions()) return;
				// Check if this user moderates or presents a session at this time period
				let [presenting, moderating] = await Promise.all([
					dbSession.run(`
						MATCH (u:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {startTime}})
						RETURN s.slug AS slug
					`, { username: user.get("username"), startTime: period.get("startTime") }),
					dbSession.run(`
						MATCH (u:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {startTime}})
						RETURN s.slug AS slug
					`, { username: user.get("username"), startTime: period.get("startTime") })
				]);
				let registerSlug: string | null = null;
				let attendanceCount = 1;
				if (presenting.records.length > 0) {
					registerSlug = presenting.records[0].get("slug");
					attendanceCount = 0;
				}
				else if (moderating.records.length > 0) {
					registerSlug = moderating.records[0].get("slug");
					attendanceCount = 0;
				}
				else {
					registerSlug = availableSessions[0].slug;
					availableSessions[0].attendees++;
				}
				// Register this user
				await dbSession.run(`
					MATCH (user:User {username: {username}})
					MATCH (session:Session {slug: {slug}})
					CREATE (user)-[r:ATTENDS]->(session)
					SET session.attendees = session.attendees + {attendanceCount}
				`, {
					username: user.get("username"),
					slug: registerSlug,
					attendanceCount
				});
			}
		}
		
		// Set all users as registered
		await dbSession.run("MATCH (u:User {registered: false}) SET u.registered = true");
		response.json({ "success": true, "message": `Successfully autoregistered ${totalUsers} users` });
	}
	catch (err) {
		common.handleError(response, err);
	}
	finally {
		dbSession.close();
	}
});
